import {
  ADAPTIVE_ACTIONS,
  EXECUTION_ACTION_RESULT_VERSION,
  EXECUTION_AGENT_OUTCOME_VERSION,
  RUNTIME_OUTCOME_VERSION,
  auditArtifactShape,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";
import {
  advanceAdaptiveMilestone,
  createAdaptiveActionAuthorizer,
  executePlan,
  observationSettleBudget,
  providerCapabilities,
  validateExecutionPlanBinding,
} from "../core/index.mjs";
import { closeSync, constants as fsConstants, fstatSync, openSync, realpathSync } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { createInMemoryEvidenceStore, redactSensitiveText } from "../evidence/index.mjs";

const PROVIDER_ID = "playwright-readonly";
const PROVIDER_VERSION = "0.1.0";
const TEXT_LIMIT = 1024 * 1024;
const DOM_LIMIT = 4 * 1024 * 1024;
const ACTION_LOG_LIMIT = 16 * 1024;
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;
const ELEMENT_TEXT_LIMIT = 4 * 1024;
const MAX_ELEMENT_OBSERVATIONS = 128;
const MAX_POST_INTERACTION_REQUESTS = 100;
const MAX_PLAN_NODES = 128;
const MAX_RUN_ARTIFACTS = 256;
const MAX_RUN_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_NODE_TIMEOUT_MS = 60_000;
// ponytail: fixed settle delay before the single navigation retry; make it configurable if a
// staging environment needs a longer token-refresh window.
const NAVIGATION_SETTLE_MS = 3_000;
const MAX_RUN_TIMEOUT_MS = 300_000;
const MAX_VIEWPORT_DIMENSION = 4096;
const MAX_VIEWPORT_AREA = 4096 * 4096;
const GATEWAY_PROVIDER_ID = "playwright-browser-tool-gateway";
const GATEWAY_PROVIDER_VERSION = "0.1.0";
const GATEWAY_DOM_LIMIT = 1024 * 1024;
const GATEWAY_ARIA_LIMIT = 512 * 1024;
const GATEWAY_MAX_ELEMENTS = 128;
const GATEWAY_ELEMENT_TEXT_LIMIT = 1024;
const GATEWAY_CLEANUP_TIMEOUT_MS = 1_000;
const adaptiveExecutions = new WeakSet();

export function normalizeAuthBootstrap(value, baseUrl) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth bootstrap is invalid");
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["url", "allowedOrigins", "allowedEndpoints"].includes(key)) || typeof value.url !== "string") throw new Error("auth bootstrap is invalid");
  const base = runtimeUrl(baseUrl);
  const url = bootstrapUrl(value.url, "auth bootstrap URL");
  const allowedOrigins = [...new Set([base.origin, url.origin, ...(Array.isArray(value.allowedOrigins) ? value.allowedOrigins : [])].map((origin) => bootstrapOrigin(origin)))];
  if (value.allowedOrigins !== undefined && !Array.isArray(value.allowedOrigins)) throw new Error("auth bootstrap is invalid");
  if (value.allowedEndpoints !== undefined && !Array.isArray(value.allowedEndpoints)) throw new Error("auth bootstrap is invalid");
  const allowedEndpoints = (value.allowedEndpoints ?? []).map((endpoint) => normalizeBootstrapEndpoint(endpoint, allowedOrigins));
  return Object.freeze({ url: url.href, allowedOrigins: Object.freeze(allowedOrigins), allowedEndpoints: Object.freeze(allowedEndpoints) });
}

function bootstrapAllowsRequest(bootstrap, requestUrl, method) {
  if (!["http:", "https:"].includes(requestUrl.protocol) || requestUrl.username || requestUrl.password) return false;
  if (["GET", "HEAD"].includes(method)) return bootstrap.allowedOrigins.includes(requestUrl.origin);
  return bootstrap.allowedEndpoints.some((endpoint) => endpoint.origin === requestUrl.origin && endpoint.path === requestUrl.pathname && endpoint.methods.includes(method));
}

function bootstrapUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("auth bootstrap is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("auth bootstrap is invalid");
  return url;
}

function bootstrapOrigin(value) {
  const url = bootstrapUrl(value, "auth bootstrap origin");
  if (url.pathname !== "/") throw new Error("auth bootstrap is invalid");
  return url.origin;
}

function normalizeBootstrapEndpoint(value, allowedOrigins) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["origin", "path", "methods"].includes(key))) throw new Error("auth bootstrap is invalid");
  const origin = bootstrapOrigin(value.origin);
  if (!allowedOrigins.includes(origin) || typeof value.path !== "string" || !/^\/[^?#]*$/.test(value.path) || !Array.isArray(value.methods) || value.methods.length === 0) throw new Error("auth bootstrap is invalid");
  const methods = [...new Set(value.methods)];
  if (methods.some((method) => !["POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new Error("auth bootstrap is invalid");
  return Object.freeze({ origin, path: value.path, methods: Object.freeze(methods) });
}

export function playwrightExecutionCapabilities() {
  return providerCapabilities({
    providerId: PROVIDER_ID,
    actions: ["NAVIGATE", "CLICK", "UPLOAD", "OBSERVE", "CHECKPOINT"],
    evidence: ["VISIBLE_TEXT", "DOM_SNAPSHOT", "ACTION_LOG", "ELEMENT_OBSERVATION"],
  });
}

export function playwrightBrowserToolCapabilities() {
  return providerCapabilities({
    providerId: GATEWAY_PROVIDER_ID,
    actions: [...ADAPTIVE_ACTIONS],
    evidence: ["DOM_SNAPSHOT", "ARIA_SNAPSHOT", "VISIBLE_TEXT", "ACTION_LOG"],
  });
}

export async function openPlaywrightBrowserToolGateway({
  input,
  browserName = "chromium",
  browserType,
  viewport = { width: 1280, height: 720 },
  secrets = [],
  storageStatePath,
  authBootstrap,
  projectRoot,
  store: sharedStore,
  priorManifest,
  clock = Date.now,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof clock !== "function" || typeof now !== "function") throw new TypeError("clock and now must be functions");
  if (!Array.isArray(secrets)) throw new TypeError("secrets must be an array");
  const initialInput = snapshotContract("ExecutionAgentInput", redactGatewayValue(snapshotContract("ExecutionAgentInput", input), secrets));
  if (storageStatePath !== undefined && (typeof storageStatePath !== "string" || storageStatePath.length === 0)) throw new TypeError("storageStatePath must be a non-empty string");
  const bootstrap = normalizeAuthBootstrap(authBootstrap, initialInput.currentPage.url);
  const deadline = readFiniteClock(clock) + initialInput.remainingBudget.timeMs;
  const capabilities = playwrightBrowserToolCapabilities();
  const store = sharedStore ?? createInMemoryEvidenceStore({ providerCapabilities: capabilities, producer: { name: GATEWAY_PROVIDER_ID, version: GATEWAY_PROVIDER_VERSION }, secrets });
  const selectedBrowserType = browserType ?? await loadBrowserType(browserName);
  if (typeof selectedBrowserType?.launch !== "function") throw new TypeError("browser type cannot launch");
  let launchPromise;
  let browser;
  try {
    browser = await runGatewayBrowserOperation({ deadline, clock }, (timeout) => {
      launchPromise = Promise.resolve(selectedBrowserType.launch({ timeout }));
      return launchPromise;
    });
  } catch (error) {
    void launchPromise?.then((lateBrowser) => closeGatewayBrowser(lateBrowser)).catch(() => undefined);
    throw error;
  }
  let context;
  let closed = false;
  let failed = false;
  let executing = false;
  let interactionStarted = false;
  let bootstrapActive = bootstrap !== undefined;
  try {
    context = await runGatewayBrowserOperation({ deadline, clock }, () => browser.newContext({ viewport: { ...viewport }, serviceWorkers: "block", ...(storageStatePath === undefined ? {} : { storageState: storageStatePath }) }));
    if (typeof context.route !== "function") throw new Error("browser context cannot enforce gateway policy");
    await runGatewayBrowserOperation({ deadline, clock }, () => context.route("**/*", async (route) => {
      try {
        const request = route.request();
        if (bootstrapActive) {
          const url = new URL(request.url());
          if (bootstrapAllowsRequest(bootstrap, url, request.method())) await route.continue();
          else await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    }));
    const page = await runGatewayBrowserOperation({ deadline, clock }, () => context.newPage());
    if (bootstrap !== undefined) {
      await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goto(bootstrap.url, { waitUntil: "domcontentloaded", timeout }));
      bootstrapActive = false;
    }
    await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goto(initialInput.currentPage.url, { waitUntil: "domcontentloaded", timeout }));
    await settleGatewayDom(page, { deadline, clock });
    assertGatewayOrigin(page, initialInput.capabilityLease.allowedOrigins);

    let currentPage = { ...initialInput.currentPage, url: gatewayUrl(page, initialInput.capabilityLease.allowedOrigins) };
    let remainingBudget = { ...initialInput.remainingBudget };
    let milestones = structuredClone(initialInput.milestones);
    let currentMilestoneId = initialInput.currentMilestoneId;
    let outcome;
    let recentObservations = [];
    let manifest = priorManifest;
    let observationSequence = 0;
    const handles = new Map();
    const usedProposalIds = new Set();

    function agentInput() {
      if (outcome !== undefined) throw new Error("adaptive execution is complete");
      remainingBudget.timeMs = Math.min(remainingBudget.timeMs, Math.max(0, Math.floor(deadline - readFiniteClock(clock))));
      return snapshotContract("ExecutionAgentInput", {
        ...initialInput,
        milestones: structuredClone(milestones),
        currentMilestoneId,
        currentPage: { ...currentPage },
        recentObservations: structuredClone(recentObservations),
        remainingBudget: { ...remainingBudget },
      });
    }

    async function execute({ proposal, tokensUsed = 0 } = {}) {
      if (closed || failed) throw new Error("browser tool gateway is closed");
      if (executing) throw new Error("browser tool gateway already has an action in progress");
      if (usedProposalIds.has(proposal?.proposalId)) throw new Error("action proposal was already consumed");
      if (!ADAPTIVE_ACTIONS.includes(proposal?.action)) throw new Error("browser tool is not implemented by this gateway slice");
      executing = true;
      let operationStarted = false;
      try {
        const beforeInput = agentInput();
        const authorization = createAdaptiveActionAuthorizer({ input: beforeInput, now: clock }).authorize({ proposal, tokensUsed });
        usedProposalIds.add(authorization.proposal.proposalId);
        remainingBudget = { ...authorization.remainingBudget };
        if (["navigate", "go_back", "reload_page"].includes(authorization.proposal.action) && interactionStarted) throw new Error("browser navigation is denied after an interaction");
        operationStarted = true;
        const before = await captureGatewayPage(page, currentPage, initialInput.capabilityLease.allowedOrigins, { deadline, clock }, secrets);
        let observation;
        let visibleText;
        if (authorization.proposal.action === "get_current_url") {
          // URL is captured in the mandatory pre/post evidence.
        } else if (authorization.proposal.action === "navigate") {
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goto(authorization.proposal.parameters.url, { waitUntil: "domcontentloaded", timeout }));
          await settleGatewayDom(page, { deadline, clock });
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "go_back") {
          const response = await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goBack({ waitUntil: "domcontentloaded", timeout }));
          if (response === null) throw new Error("browser history has no previous page");
          await settleGatewayDom(page, { deadline, clock });
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "reload_page") {
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.reload({ waitUntil: "domcontentloaded", timeout }));
          await settleGatewayDom(page, { deadline, clock });
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "observe_dom" || authorization.proposal.action === "observe_aria") {
          observation = await observeGatewayElements({ page, input: beforeInput, currentPage, sequence: ++observationSequence, secrets: [...secrets, ...before.sensitiveValues], deadline, clock });
          recentObservations = [observation.contract];
          handles.clear();
          observation.handles.forEach((locator, elementId) => handles.set(`${observation.contract.observationId}\0${elementId}`, locator));
        } else if (authorization.proposal.action === "click_observed_element") {
          const locator = handles.get(`${authorization.proposal.parameters.observationId}\0${authorization.proposal.parameters.elementId}`);
          if (!locator) throw new Error("observed element handle is unavailable");
          await runGatewayBrowserOperation({ deadline, clock }, () => assertSafeClickTarget(locator));
          interactionStarted = true;
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => locator.click({ timeout: Math.min(10_000, timeout) }));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "hover_observed_element") {
          const locator = handles.get(`${authorization.proposal.parameters.observationId}\0${authorization.proposal.parameters.elementId}`);
          if (!locator) throw new Error("observed element handle is unavailable");
          await runGatewayBrowserOperation({ deadline, clock }, () => assertSafeClickTarget(locator));
          interactionStarted = true;
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => locator.hover({ timeout: Math.min(10_000, timeout) }));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "upload_observed_element") {
          const locator = handles.get(`${authorization.proposal.parameters.observationId}\0${authorization.proposal.parameters.elementId}`);
          if (!locator) throw new Error("observed element handle is unavailable");
          // The file is the milestone's author-designated @qa-fixture, resolved strictly inside the
          // project root — the AI chooses the element, never the file.
          const uploadMilestone = input.milestones.find((milestone) => milestone.id === authorization.proposal.milestoneId);
          if (!uploadMilestone?.fixture) throw new Error("upload milestone has no designated fixture");
          let file;
          try {
            file = resolveFixtureFile(projectRoot, uploadMilestone.fixture.path);
          } catch {
            throw new Error("upload fixture is unavailable or outside the project root");
          }
          interactionStarted = true;
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => locator.setInputFiles(file, { timeout: Math.min(10_000, timeout) }));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "scroll_view") {
          interactionStarted = true;
          await runGatewayBrowserOperation({ deadline, clock }, () => page.mouse.wheel(authorization.proposal.parameters.deltaX, authorization.proposal.parameters.deltaY));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "wait_for_element_state") {
          const locator = handles.get(`${authorization.proposal.parameters.observationId}\0${authorization.proposal.parameters.elementId}`);
          if (!locator) throw new Error("observed element handle is unavailable");
          const timeout = Math.min(authorization.proposal.parameters.timeoutMs, remainingBudget.timeMs);
          if (["visible", "hidden"].includes(authorization.proposal.parameters.state)) {
            await runGatewayBrowserOperation({ deadline, clock }, (remainingTime) => locator.waitForElementState(authorization.proposal.parameters.state, { timeout: Math.min(timeout, remainingTime) }));
          } else {
            await runGatewayBrowserOperation({ deadline, clock }, (remainingTime) => page.waitForFunction(
              ({ element, expectedPresent }) => element.isConnected === expectedPresent,
              { element: locator, expectedPresent: authorization.proposal.parameters.state === "present" },
              { timeout: Math.min(timeout, remainingTime) },
            ));
          }
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "press_key") {
          interactionStarted = true;
          await runGatewayBrowserOperation({ deadline, clock }, () => page.keyboard.press("Escape"));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "report_blocked") {
          // Seal the full page the agent claims is blocked; the reason stays a claim for the judge, never a verdict.
          visibleText = await captureGatewayVisibleText(page, { deadline, clock }, [...secrets, ...before.sensitiveValues]);
        }
        const nextUrl = gatewayUrl(page, initialInput.capabilityLease.allowedOrigins);
        if (["navigate", "go_back", "reload_page"].includes(authorization.proposal.action) || nextUrl !== currentPage.url) {
          currentPage = { pageId: `page-${canonicalHash({ proposalId: authorization.proposal.proposalId, nextUrl }).slice("sha256:".length, "sha256:".length + 12)}`, domGeneration: 1, url: nextUrl };
          recentObservations = [];
          handles.clear();
        }
        const after = await captureGatewayPage(page, currentPage, initialInput.capabilityLease.allowedOrigins, { deadline, clock }, secrets);
        currentPage.url = after.page.url;
        remainingBudget.timeMs = Math.min(remainingBudget.timeMs, Math.max(0, Math.floor(deadline - readFiniteClock(clock))));
        const artifacts = [
          ...captureGatewayArtifacts(store, authorization.proposal, before, after, observation?.contract.satisfiedMilestoneIds ?? []),
          ...(visibleText === undefined ? [] : [store.captureArtifact({ id: `${authorization.proposal.proposalId}:visible-text`, type: "VISIBLE_TEXT", contentType: "text/plain", content: visibleText })]),
        ];
        const facts = [
          { id: `${authorization.proposal.proposalId}:url`, kind: "URL", value: after.page.url },
          { id: `${authorization.proposal.proposalId}:audit`, kind: "BROWSER_TOOL_AUDIT", value: { action: authorization.proposal.action, proposalId: authorization.proposal.proposalId, before: before.page, after: after.page, status: "ACCEPTED" } },
        ];
        const evidenceRefs = [...artifacts.map((artifact) => artifact.id), ...facts.map((fact) => fact.id)];
        const result = snapshotContract("ExecutionActionResult", {
          schemaVersion: EXECUTION_ACTION_RESULT_VERSION,
          resultId: `result-${canonicalHash({ proposalId: authorization.proposal.proposalId, evidenceRefs, page: after.page }).slice("sha256:".length, "sha256:".length + 16)}`,
          proposalId: authorization.proposal.proposalId,
          accepted: true,
          policyReason: "ACCEPTED",
          evidenceRefs,
          page: { ...after.page },
          remainingBudget: { ...remainingBudget },
        }, { input: beforeInput, proposal: authorization.proposal });
        const bundle = store.createBundle({
          runId: initialInput.runId,
          scenarioId: initialInput.scenarioId,
          checkpointId: authorization.proposal.proposalId,
          capturedAt: now(),
          environment: { targetUrl: after.page.url, browser: browserName, viewport: page.viewportSize?.() ?? { ...viewport } },
          artifacts,
          facts,
        });
        manifest = store.appendCheckpoint(bundle, { stage: "execute", ...(manifest === undefined ? {} : { manifest }) });
        const observedContract = observation?.contract;
        const transition = advanceAdaptiveMilestone({ input: beforeInput, proposal: authorization.proposal, result, ...(observedContract ? { observation: observedContract } : {}) });
        if (transition?.input) {
          milestones = structuredClone(transition.input.milestones);
          currentMilestoneId = transition.input.currentMilestoneId;
          recentObservations = [];
          handles.clear();
        } else if (transition?.outcome) {
          milestones = milestones.map((item) => item.id === beforeInput.currentMilestoneId ? { ...item, status: authorization.proposal.action === "report_blocked" ? "BLOCKED" : "COMPLETED" } : item);
          outcome = transition.outcome;
          recentObservations = [];
          handles.clear();
        }
        return Object.freeze({ result, bundle, manifest, ...(observedContract ? { observation: observedContract } : {}), ...(outcome ? { outcome } : {}) });
      } catch (error) {
        if (operationStarted) {
          failed = true;
          await close();
        }
        throw error;
      } finally {
        executing = false;
      }
    }

    function invalidateGatewayObservations() {
      currentPage = { ...currentPage, domGeneration: currentPage.domGeneration + 1 };
      recentObservations = [];
      handles.clear();
    }

    async function close() {
      if (closed) return;
      closed = true;
      await closeGatewayBrowser(browser);
    }

    return Object.freeze({ agentInput, capabilities, close, execute, readBlob: store.readBlob });
  } catch (error) {
    closed = true;
    await closeGatewayBrowser(browser).catch(() => undefined);
    throw error;
  }
}

// Shared observation settle: both the strict OBSERVE node and the adaptive gateway route every
// evidence capture through this wait. SSR HTML can lack testids the client only attaches after
// hydration, so evidence sealed at domcontentloaded misleads the judge. The page counts as
// settled once it is fully loaded and the DOM stays quiet; the cap (core's observationSettleBudget)
// keeps the wait bounded when an app mutates forever (carousels, polling). Never throws — under
// budget pressure or an evaluate/navigation race the capture proceeds with the DOM as-is.
async function settleDomForObservation(page, remainingMs) {
  const budget = observationSettleBudget(remainingMs);
  if (budget === undefined) return;
  try {
    await page.evaluate(({ capMs, quietMs }) => new Promise((resolve) => {
      let timer;
      const finish = () => {
        observer.disconnect();
        document.removeEventListener("readystatechange", arm);
        clearTimeout(timer);
        resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => (document.readyState === "complete" ? finish() : arm()), quietMs);
      };
      const observer = new MutationObserver(arm);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener("readystatechange", arm);
      setTimeout(finish, capMs);
      arm();
    }), budget);
  } catch {
    // Budget exhausted or evaluate raced a navigation; capture proceeds with the DOM as-is.
  }
}

async function settleGatewayDom(page, timing) {
  try {
    await runGatewayBrowserOperation(timing, (remaining) => settleDomForObservation(page, remaining));
  } catch {
    // Gateway time budget exhausted; capture proceeds with the DOM as-is.
  }
}

async function captureGatewayPage(page, currentPage, allowedOrigins, timing, secrets) {
  const url = gatewayUrl(page, allowedOrigins);
  const capturedDom = await runGatewayBrowserOperation(timing, (timeout) => page.locator("html").evaluate((element, maxChars) => {
    const credentialPattern = /password|secret|token|api[-_ ]?key|authorization|credential|session|csrf|nonce|recovery[-_ ]?code|one[-_ ]?time|otp|passcode|private[-_ ]?key/i;
    const urlAttributeNames = new Set(["action", "archive", "attributionsrc", "background", "cite", "classid", "codebase", "data", "formaction", "href", "icon", "imagesrcset", "itemid", "longdesc", "manifest", "ping", "poster", "profile", "src", "srcdoc", "srcset", "usemap", "xlink:href"]);
    const sensitiveValues = [];
    let sensitiveValuesOverflow = false;
    const remember = (value) => {
      if (typeof value !== "string" || value.length === 0 || sensitiveValues.includes(value)) return;
      if (value.length > 4_096 || sensitiveValues.length >= 128) {
        sensitiveValuesOverflow = true;
        return;
      }
      sensitiveValues.push(value);
    };
    element.querySelectorAll("input, textarea, select").forEach((node) => remember(node.value));
    [element, ...element.querySelectorAll("*")].forEach((node) => {
      const identity = ["name", "id", "class", "aria-label", "autocomplete"].map((name) => node.getAttribute(name) ?? "").join(" ");
      if (credentialPattern.test(identity)) {
        remember(node.value);
        remember(node.textContent);
      }
      for (const attribute of [...node.attributes]) {
        if (credentialPattern.test(attribute.name)) remember(node.getAttribute(attribute.name));
      }
      if (node.tagName.toLowerCase() === "meta" && credentialPattern.test(node.getAttribute("name") ?? "")) remember(node.getAttribute("content"));
    });
    const clone = element.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
    clone.querySelectorAll("input, textarea, select").forEach((node) => {
      node.removeAttribute("value");
      if (node.tagName.toLowerCase() === "textarea") node.textContent = "";
    });
    [clone, ...clone.querySelectorAll("*")].forEach((node) => {
      const identity = ["name", "id", "class", "aria-label", "autocomplete"].map((name) => node.getAttribute(name) ?? "").join(" ");
      if (credentialPattern.test(identity)) {
        node.removeAttribute("value");
        node.textContent = "";
      }
      for (const attribute of [...node.attributes]) {
        if (credentialPattern.test(attribute.name) || /^on/i.test(attribute.name) || attribute.name === "style" || urlAttributeNames.has(attribute.name.toLowerCase())) node.removeAttribute(attribute.name);
      }
      if (node.tagName.toLowerCase() === "meta") node.removeAttribute("content");
    });
    return { dom: clone.outerHTML.slice(0, maxChars), sensitiveValues, sensitiveValuesOverflow };
  }, GATEWAY_DOM_LIMIT + 1, { timeout }));
  if (!capturedDom || typeof capturedDom.dom !== "string" || !Array.isArray(capturedDom.sensitiveValues) || capturedDom.sensitiveValuesOverflow !== false || capturedDom.sensitiveValues.length > 128 || capturedDom.sensitiveValues.some((value) => typeof value !== "string" || value.length > 4_096)) throw new Error("browser returned invalid sanitized DOM evidence");
  const dom = boundedText(redactSensitiveText(capturedDom.dom, [...secrets, ...capturedDom.sensitiveValues]), GATEWAY_DOM_LIMIT, "DOM_SNAPSHOT");
  const ariaLocator = page.locator("body");
  if (typeof ariaLocator.ariaSnapshot !== "function") throw new Error("browser cannot capture ARIA evidence");
  const rawAria = await runGatewayBrowserOperation(timing, (timeout) => ariaLocator.ariaSnapshot({ timeout }));
  const aria = boundedText(redactSensitiveText(rawAria, [...secrets, ...capturedDom.sensitiveValues]).replace(/^(\s*-\s*\/url:).*$/gm, "$1 [REDACTED]"), GATEWAY_ARIA_LIMIT, "ARIA_SNAPSHOT");
  return { page: { ...currentPage, url }, dom, aria, sensitiveValues: capturedDom.sensitiveValues };
}

async function captureGatewayVisibleText(page, timing, secrets) {
  const raw = await runGatewayBrowserOperation(timing, (timeout) => page.locator("body").evaluate((element, maxChars) => (element.innerText ?? "").slice(0, maxChars), GATEWAY_DOM_LIMIT + 1, { timeout }));
  if (typeof raw !== "string") throw new Error("browser returned invalid visible text evidence");
  return boundedText(redactSensitiveText(raw, secrets), GATEWAY_DOM_LIMIT, "VISIBLE_TEXT");
}

async function observeGatewayElements({ page, input, currentPage, sequence, secrets, deadline, clock }) {
  const locator = page.locator("button, [role='button'], [role='menuitem'], dialog, [role='dialog'], a[href], input, select, textarea, [tabindex]");
  const timing = { deadline, clock };
  const count = await runGatewayBrowserOperation(timing, () => locator.count());
  if (!Number.isInteger(count) || count < 0 || count > GATEWAY_MAX_ELEMENTS) throw new Error("gateway element observation exceeds its bound");
  const observationId = `observation-${canonicalHash({ runId: input.runId, scenarioId: input.scenarioId, pageId: currentPage.pageId, domGeneration: currentPage.domGeneration, sequence }).slice("sha256:".length, "sha256:".length + 16)}`;
  const elements = [];
  const handles = new Map();
  const satisfiedMilestoneIds = await evaluateSemanticMilestones(page, input.milestones, timing);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const handle = await runGatewayBrowserOperation(timing, (timeout) => candidate.elementHandle({ timeout }));
    if (!handle || !(await runGatewayBrowserOperation(timing, () => handle.isVisible()))) continue;
    const metadata = await runGatewayBrowserOperation(timing, () => handle.evaluate((element, maxChars) => {
      const credentialPattern = /password|secret|token|api[-_ ]?key|authorization|credential|session|csrf|nonce|recovery[-_ ]?code|one[-_ ]?time|otp|passcode|private[-_ ]?key/i;
      const tag = element.tagName.toLowerCase();
      const text = (element.textContent ?? "").trim().slice(0, maxChars + 1);
      const role = element.getAttribute("role") || (tag === "button" ? "button" : tag === "a" ? "link" : tag === "dialog" ? "dialog" : undefined);
      const semanticContainer = tag === "dialog" || role === "dialog";
      let protectedElement = false;
      for (let current = element; current && !protectedElement; current = current.parentElement) {
        protectedElement = credentialPattern.test(["name", "id", "class", "aria-label", "autocomplete", "data-testid"].map((name) => current.getAttribute(name) ?? "").join(" "));
      }
      return {
        tag,
        role,
        accessibleName: protectedElement ? "[REDACTED]" : element.getAttribute("aria-label") || (semanticContainer ? "" : text),
        text: protectedElement ? "[REDACTED]" : semanticContainer ? "" : text,
        testId: element.getAttribute("data-testid") || undefined,
        protected: protectedElement,
        semanticContainer,
        anchor: element.closest("a[href]") !== null,
        form: element.closest("form") !== null,
        editable: element.isContentEditable || ["input", "select", "textarea"].includes(tag),
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      };
    }, GATEWAY_ELEMENT_TEXT_LIMIT));
    if (!metadata || typeof metadata.text !== "string" || metadata.text.length > GATEWAY_ELEMENT_TEXT_LIMIT) throw new Error("gateway element metadata is invalid or truncated");
    const protectedValue = [metadata.accessibleName, metadata.text].some((value) => typeof value === "string" && secrets.some((secret) => secret.length > 0 && value.includes(secret)));
    const safe = !metadata.protected && !protectedValue && !metadata.semanticContainer && !metadata.anchor && !metadata.form && !metadata.editable && !metadata.disabled;
    const elementId = `element-${canonicalHash({ observationId, index }).slice("sha256:".length, "sha256:".length + 16)}`;
    const milestoneIds = metadata.protected || protectedValue ? [] : input.milestones.filter((milestone) => milestone.target && gatewayTargetMatches(milestone.target, metadata)).map((milestone) => milestone.id);
    const allowedActions = [
      ...(input.capabilityLease.actions.includes("wait_for_element_state") ? ["wait_for_element_state"] : []),
      ...(safe && input.capabilityLease.actions.includes("click_observed_element") ? ["click_observed_element"] : []),
      ...(safe && input.capabilityLease.actions.includes("hover_observed_element") ? ["hover_observed_element"] : []),
      // Upload is allowed only on the element matching an upload milestone's target (a file input),
      // even though file inputs are otherwise "unsafe" (editable). The fixture is author-designated.
      ...(input.capabilityLease.actions.includes("upload_observed_element") && input.milestones.some((milestone) => milestone.requiredAction === "upload_observed_element" && milestoneIds.includes(milestone.id)) ? ["upload_observed_element"] : []),
    ];
    elements.push({
      elementId,
      milestoneIds,
      allowedActions,
      ...(metadata.role ? { role: redactSensitiveText(metadata.role, secrets) } : {}),
      ...(metadata.accessibleName ? { accessibleName: redactSensitiveText(metadata.accessibleName, secrets) } : {}),
      ...(metadata.text ? { text: redactSensitiveText(metadata.text, secrets) } : {}),
    });
    handles.set(elementId, handle);
  }
  return {
    contract: {
      observationId,
      pageId: currentPage.pageId,
      domGeneration: currentPage.domGeneration,
      elements,
      satisfiedMilestoneIds,
    },
    handles,
  };
}

async function evaluateSemanticMilestones(page, milestones, timing) {
  const satisfied = [];
  for (const milestone of milestones) {
    if (milestone.class !== "REQUIRED_SEMANTIC_MILESTONE" || !milestone.target || !milestone.expectation) continue;
    const locator = semanticLocator(page, milestone.target, { allowUnsupported: true });
    if (!locator) continue;
    const count = await runGatewayBrowserOperation(timing, () => locator.count());
    if (!Number.isInteger(count) || count < 0 || count > GATEWAY_MAX_ELEMENTS) throw new Error("gateway semantic observation exceeds its bound");
    const visible = [];
    // Tolerate mount/entry animations: wait for visibility, bounded so it does not eat the adaptive time budget. `remaining` is the gateway op's own deadline, so the waitFor always settles before the wrapper times out.
    for (let index = 0; index < count; index += 1) {
      const element = locator.nth(index);
      visible.push(await runGatewayBrowserOperation(timing, (remaining) => element.waitFor({ state: "visible", timeout: Math.min(remaining, 2000) }).then(() => true, () => false)));
    }
    const kind = milestone.expectation.kind;
    if (kind === "NOT_VISIBLE" && visible.every((value) => value === false)) {
      satisfied.push(milestone.id);
      continue;
    }
    if (count !== 1 || visible[0] !== true) continue;
    if (kind === "DISABLED" && !(await runGatewayBrowserOperation(timing, () => locator.isDisabled()))) continue;
    if (kind === "CONTAINS_TEXT") {
      const text = await runGatewayBrowserOperation(timing, (timeout) => locator.evaluate((element, maxChars) => (element.textContent ?? "").slice(0, maxChars + 1), GATEWAY_ELEMENT_TEXT_LIMIT, { timeout }));
      if (typeof text !== "string" || text.length > GATEWAY_ELEMENT_TEXT_LIMIT || !text.includes(milestone.expectation.expected.value)) continue;
    }
    satisfied.push(milestone.id);
  }
  return satisfied;
}

function gatewayTargetMatches(target, metadata) {
  let constrained = false;
  if (target.testId !== undefined) {
    constrained = true;
    if (target.testId !== metadata.testId) return false;
  }
  if (target.role !== undefined) {
    constrained = true;
    if (target.role !== metadata.role) return false;
  }
  if (target.accessibleName !== undefined) {
    constrained = true;
    if (target.accessibleName.kind !== "literal") return false;
    if (target.accessibleName.value !== metadata.accessibleName) return false;
  }
  if (target.text !== undefined) {
    constrained = true;
    if (target.text.kind !== "literal") return false;
    if (target.text.value !== metadata.text) return false;
  }
  return constrained;
}

function captureGatewayArtifacts(store, proposal, before, after, satisfiedMilestoneIds) {
  const auditProposal = structuredClone(proposal);
  if (auditProposal.action === "navigate") {
    const url = new URL(auditProposal.parameters.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    auditProposal.parameters.url = url.href;
  }
  const content = {
    "before:dom": { contentType: "text/html", content: before.dom },
    "before:aria": { contentType: "text/plain", content: before.aria },
    action: { contentType: "application/json", content: JSON.stringify({ proposal: auditProposal, status: "ACCEPTED", before: before.page, after: after.page, satisfiedMilestoneIds }) },
    "after:dom": { contentType: "text/html", content: after.dom },
    "after:aria": { contentType: "text/plain", content: after.aria },
  };
  return auditArtifactShape(proposal.action).required.map((entry) =>
    store.captureArtifact({ id: `${proposal.proposalId}:${entry.suffix}`, type: entry.type, ...content[entry.suffix] }));
}

function gatewayUrl(page, allowedOrigins) {
  const url = assertGatewayOrigin(page, allowedOrigins);
  url.search = "";
  url.hash = "";
  return url.href;
}

function assertGatewayOrigin(page, allowedOrigins) {
  const url = new URL(String(page.url()));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !allowedOrigins.includes(url.origin)) throw new Error("browser left the gateway capability origins");
  return url;
}

function readFiniteClock(clock) {
  const value = clock();
  if (!Number.isFinite(value)) throw new TypeError("clock must return a finite number");
  return value;
}

async function runGatewayBrowserOperation({ deadline, clock }, operation) {
  const timeout = Math.max(0, Math.floor(deadline - readFiniteClock(clock)));
  if (timeout < 1) throw new Error("browser tool gateway time budget is exhausted");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(timeout)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser tool gateway time budget is exhausted")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeGatewayBrowser(browser) {
  if (typeof browser?.close !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => browser.close()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, GATEWAY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function redactGatewayValue(value, secrets) {
  if (typeof value === "string") return redactSensitiveText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactGatewayValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactGatewayValue(item, secrets)]));
  return value;
}

function budgetSummary(initialBudget, remainingBudget) {
  return ["actions", "turns", "timeMs", "tokens"]
    .map((key) => `${key} ${initialBudget[key] - remainingBudget[key]}/${initialBudget[key]}`)
    .join(" ");
}

export async function runAdaptiveWithPlaywright({
  input,
  proposeAction,
  browserName = "chromium",
  browserType,
  viewport,
  secrets = [],
  storageStatePath,
  authBootstrap,
  projectRoot,
  store,
  priorManifest,
  now = () => new Date().toISOString(),
  clock = Date.now,
} = {}) {
  if (typeof proposeAction !== "function") throw new Error("proposeAction must be a function");
  const gateway = await openPlaywrightBrowserToolGateway({ input, browserName, browserType, viewport, secrets, storageStatePath, authBootstrap, projectRoot, store, priorManifest, now, clock });
  const bundles = [];
  let manifest;
  let outcome;
  try {
    while (outcome === undefined) {
      const proposerInput = gateway.agentInput();
      if (Object.values(proposerInput.remainingBudget).some((value) => value < 1)) {
        outcome = snapshotContract("ExecutionAgentOutcome", {
          schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
          runId: input.runId,
          scenarioId: input.scenarioId,
          type: "ERROR",
          completedMilestoneIds: proposerInput.milestones.filter((milestone) => milestone.status === "COMPLETED").map((milestone) => milestone.id),
          reason: `BUDGET_EXHAUSTED: ${budgetSummary(input.remainingBudget, proposerInput.remainingBudget)}`,
        });
        break;
      }
      const proposed = await runGatewayBrowserOperation({ deadline: readFiniteClock(clock) + proposerInput.remainingBudget.timeMs, clock }, () => proposeAction(proposerInput));
      if (!proposed?.proposal || typeof proposed.proposal !== "object") throw new Error("adaptive proposer must return a proposal and token usage");
      if (!Number.isInteger(proposed.tokensUsed) || proposed.tokensUsed < 0) throw new Error("adaptive proposer token usage must be a non-negative integer");
      const execution = await gateway.execute({ proposal: proposed.proposal, tokensUsed: proposed.tokensUsed });
      bundles.push(execution.bundle);
      manifest = execution.manifest;
      outcome = execution.outcome;
    }
    const execution = Object.freeze({ outcome, bundles: Object.freeze(bundles), manifest, readBlob: gateway.readBlob });
    adaptiveExecutions.add(execution);
    return execution;
  } finally {
    await gateway.close();
  }
}

export async function runAdaptiveSuiteWithPlaywright({ inputs, proposeAction, ...options } = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("adaptive suite requires at least one scenario input");
  if (new Set(inputs.map((input) => input?.runId)).size !== 1) throw new Error("adaptive suite inputs must share one runId");
  const store = createInMemoryEvidenceStore({ providerCapabilities: playwrightBrowserToolCapabilities(), producer: { name: GATEWAY_PROVIDER_ID, version: GATEWAY_PROVIDER_VERSION }, secrets: options.secrets ?? [] });
  const bundles = [];
  const executions = [];
  let manifest;
  for (const input of inputs) {
    let execution;
    try {
      execution = await runAdaptiveWithPlaywright({ input, proposeAction, store, priorManifest: manifest, ...options });
    } catch (error) {
      executions.push(Object.freeze({
        scenarioId: input.scenarioId,
        input,
        outcome: snapshotContract("ExecutionAgentOutcome", {
          schemaVersion: EXECUTION_AGENT_OUTCOME_VERSION,
          runId: input.runId,
          scenarioId: input.scenarioId,
          type: "ERROR",
          completedMilestoneIds: [],
          reason: String(error.message).slice(0, 4_096),
        }),
        bundleIds: Object.freeze([]),
      }));
      continue;
    }
    bundles.push(...execution.bundles);
    manifest = execution.manifest ?? manifest;
    executions.push(Object.freeze({ scenarioId: input.scenarioId, input, outcome: execution.outcome, bundleIds: Object.freeze(execution.bundles.map((bundle) => bundle.bundleId)) }));
  }
  const suite = Object.freeze({ outcome: executions[executions.length - 1].outcome, bundles: Object.freeze(bundles), manifest, readBlob: store.readBlob, executions: Object.freeze(executions) });
  adaptiveExecutions.add(suite);
  return suite;
}

export function assertPlaywrightAdaptiveExecution(execution) {
  if (!execution || typeof execution !== "object" || !adaptiveExecutions.has(execution)) throw new Error("adaptive execution did not originate from the Playwright gateway");
  return execution;
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
  storageStatePath,
  authBootstrap,
  projectRoot,
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
    runtime = createRuntime({ qaIr, baseUrl, runId, browserName, browserType, viewport, locale, timezoneId, secrets, storageStatePath, authBootstrap, projectRoot, now, capabilities, nodeTimeoutMs: plan.timeoutPolicy.perNodeMs });
  } catch {
    return executionResult(runtimeError("CONTRACT_VIOLATION", "Execution provider input is invalid"));
  }

  // QA_NATIVE_TRACE_TIMING=1 prints one start/done line per node to stderr. This exists to locate
  // hangs (the start line without a done line names the stuck node); heavyweight logging like
  // DEBUG=pw:api changes scheduling enough to mask races, so keep this the only sanctioned probe.
  const traceTiming = process.env.QA_NATIVE_TRACE_TIMING === "1";
  const executeNode = !traceTiming ? runtime.executeNode : async (node) => {
    const startedAt = performance.now();
    process.stderr.write(`qa-native timing: ${node.nodeId} ${node.kind} start\n`);
    try {
      return await runtime.executeNode(node);
    } finally {
      process.stderr.write(`qa-native timing: ${node.nodeId} ${node.kind} ${Math.round(performance.now() - startedAt)}ms\n`);
    }
  };
  let outcome = await executePlan({
    plan,
    providerCapabilities: runtime.capabilities,
    executeNode,
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

function createRuntime({ qaIr, baseUrl, runId, browserName, browserType, viewport, locale, timezoneId, secrets, storageStatePath, authBootstrap, projectRoot, now, capabilities, nodeTimeoutMs }) {
  const base = runtimeUrl(baseUrl);
  const bootstrap = normalizeAuthBootstrap(authBootstrap, base.href);
  if (typeof runId !== "string" || runId.length === 0) throw new Error("runId must be a non-empty string");
  if (!Array.isArray(secrets)) throw new Error("secrets must be an array");
  if (!["chromium", "firefox", "webkit"].includes(browserName)) throw new Error("browserName is unsupported");
  if (locale !== undefined && (typeof locale !== "string" || locale.length === 0)) throw new Error("locale must be a non-empty string");
  if (timezoneId !== undefined && (typeof timezoneId !== "string" || timezoneId.length === 0)) throw new Error("timezoneId must be a non-empty string");
  if (storageStatePath !== undefined && (typeof storageStatePath !== "string" || storageStatePath.length === 0)) throw new Error("storageStatePath must be a non-empty string");
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
  let bootstrapActive = bootstrap !== undefined;
  let postInteractionRequests = [];

  function isReadOnlySameOriginRequest(requestUrl, method) {
    return ["GET", "HEAD"].includes(method)
      && ["http:", "https:"].includes(requestUrl.protocol)
      && requestUrl.origin === base.origin
      && !requestUrl.username && !requestUrl.password;
  }

  // Consumer apps serve their API from a sibling origin (app.example.test → api.example.test);
  // blocking those page-initiated reads breaks the page under test itself. Reads to foreign sites
  // stay blocked — this loosens the pre-interaction guard to the registrable domain only, never
  // to mutations, and the stricter same-origin rule still governs post-interaction traffic.
  function isReadOnlySameSiteRequest(requestUrl, method) {
    return ["GET", "HEAD"].includes(method)
      && ["http:", "https:"].includes(requestUrl.protocol)
      && registrableDomain(requestUrl.hostname) === registrableDomain(base.hostname)
      && !requestUrl.username && !requestUrl.password;
  }

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
      if (storageStatePath !== undefined) contextOptions.storageState = storageStatePath;
      const context = await browser.newContext(contextOptions);
      if (typeof context.route !== "function" || typeof context.routeWebSocket !== "function") throw new Error("browser context cannot enforce request policy");
      await context.route("**/*", async (route) => {
        try {
          const request = route.request();
          const requestUrl = new URL(request.url());
          if (bootstrapActive) {
            if (bootstrapAllowsRequest(bootstrap, requestUrl, request.method())) await route.continue();
            else await route.abort("blockedbyclient");
            return;
          }
          if (interactionStarted) {
            if (isReadOnlySameOriginRequest(requestUrl, request.method())) {
              if (postInteractionRequests.length < MAX_POST_INTERACTION_REQUESTS) {
                postInteractionRequests.push({ method: request.method(), origin: requestUrl.origin, path: requestUrl.pathname });
              }
              await route.continue();
              return;
            }
            interactionPolicyViolation = true;
            await route.abort("blockedbyclient");
            return;
          }
          if (!isReadOnlySameSiteRequest(requestUrl, request.method())) {
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
      if (bootstrap !== undefined) {
        await page.goto(bootstrap.url, { waitUntil: "domcontentloaded", timeout: nodeTimeoutMs });
        bootstrapActive = false;
      }
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
      // A stale access token can bounce the first hit to a login route while the app silently
      // refreshes the session in the background. One bounded re-navigation reaches the refreshed
      // page; a healthy landing (same pathname) never triggers it, and the observation still
      // records whatever the final page truly shows.
      if (new URL(String(page.url())).pathname !== target.pathname) {
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: nodeTimeoutMs });
      }
      assertPageOrigin(page, base);
      return;
    }
    if (node.kind === "OBSERVE") {
      const page = await openPage();
      assertPageOrigin(page, base);
      const state = observationState(observations, node.scenarioId);
      try {
        await settleDomForObservation(page, nodeTimeoutMs);
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
      if ((node.action !== "CLICK" && node.action !== "UPLOAD") || node.evidence.length !== 1 || node.evidence[0] !== "ACTION_LOG") throw providerError("POLICY_VIOLATION");
      const page = await openPage();
      const beforeUrl = evidenceUrl(page, base);
      if (node.action === "UPLOAD") {
        // File upload is the exception interaction: replay the test's declared `@qa-fixture` file
        // into the target file input. The fixture file is resolved strictly inside the project root
        // (no symlink escape, bounded size) before Playwright ever touches it.
        const fixturePath = entry.scenario.fixtures?.[node.value ?? ""];
        if (typeof fixturePath !== "string") throw providerError("POLICY_VIOLATION");
        const file = resolveFixtureFile(projectRoot, fixturePath);
        const locator = semanticLocator(page, step.target, { allowUnsupported: true });
        if (!locator) throw providerError("CONTRACT_VIOLATION");
        interactionStarted = true;
        await locator.setInputFiles(file, { timeout: nodeTimeoutMs });
        if (interactionPolicyViolation) throw providerError("POLICY_VIOLATION");
        const afterUrl = evidenceUrl(page, base);
        const content = boundedText(JSON.stringify({ action: "UPLOAD", target: actionLogTarget(step.target), fixture: node.value, beforeUrl, afterUrl, status: "SUCCEEDED", allowedRequests: postInteractionRequests }), ACTION_LOG_LIMIT, "ACTION_LOG");
        postInteractionRequests = [];
        observationState(observations, node.scenarioId).artifacts.push(captureArtifact(`${node.nodeId}:action_log`, "ACTION_LOG", "application/json", content));
        return;
      }
      const locator = semanticLocator(page, step.target, { requireAccessibleName: true });
      if (!locator) throw providerError("CONTRACT_VIOLATION");
      await assertSafeClickTarget(locator, nodeTimeoutMs);
      interactionStarted = true;
      await locator.click({ timeout: nodeTimeoutMs });
      if (interactionPolicyViolation) throw providerError("POLICY_VIOLATION");
      const afterUrl = evidenceUrl(page, base);
      const content = boundedText(JSON.stringify({ action: "CLICK", target: actionLogTarget(step.target), beforeUrl, afterUrl, status: "SUCCEEDED", allowedRequests: postInteractionRequests }), ACTION_LOG_LIMIT, "ACTION_LOG");
      postInteractionRequests = [];
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

// Resolve a repo-relative `@qa-fixture` path to a real file strictly inside the project root, with
// no symlink escape and a bounded size, before it is handed to Playwright's setInputFiles.
function resolveFixtureFile(projectRoot, repoRelativePath) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) throw providerError("POLICY_VIOLATION");
  const root = realpathSync(projectRoot);
  let real;
  try {
    real = realpathSync(resolvePath(root, repoRelativePath));
  } catch {
    throw providerError("EVIDENCE_STORAGE_FAILED");
  }
  if (real !== root && !real.startsWith(root + pathSep)) throw providerError("POLICY_VIOLATION");
  const fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) throw providerError("POLICY_VIOLATION");
  } finally {
    closeSync(fd);
  }
  return real;
}

async function assertSafeClickTarget(locator, timeout) {
  const readTarget = (element) => ({
    anchor: element.closest("a[href]") !== null,
    form: element.closest("form") !== null,
    editable: element.isContentEditable,
  });
  const target = timeout === undefined
    ? await locator.evaluate(readTarget)
    : await locator.evaluate(readTarget, undefined, { timeout });
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
  // Entry-animation waits (VISIBLE/CONTAINS_TEXT targets that mount hidden) share one budget with
  // headroom under the node timeout: a still-hidden element must end as an observed visible:false
  // fact, never as a node timeout that kills the whole run. NOT_VISIBLE/PRESENT expectations take
  // an instant snapshot — waiting for a deliberately hidden element to become visible was the
  // strict one-shot race (element in DOM but hidden → full-timeout wait → run death).
  // 0.8 × 30s = 24s covers the 20s assertion timeouts consumer specs declare while leaving
  // headroom under the node timeout; an element still hidden past the spec's own wait would fail
  // the real Playwright test too, so recording visible:false there is spec-faithful.
  const visibilityDeadline = Date.now() + Math.max(1, Math.floor(timeout * 0.8));
  for (const expectation of expectations) {
    if (!["CONTAINS_TEXT", "VISIBLE", "NOT_VISIBLE", "PRESENT"].includes(expectation.kind)) continue;
    const locator = semanticLocator(page, expectation.target, { allowUnsupported: true });
    if (!locator) continue;
    const expectsVisible = ["CONTAINS_TEXT", "VISIBLE"].includes(expectation.kind);
    let count = await locator.count();
    const id = `${nodeId}:element:${expectation.id}`;
    if (count === 0 && expectsVisible) {
      // Playwright assertions retry for their declared timeout; mirror that for appearance so an
      // observation taken mid-render doesn't turn a still-loading page into a MISSING fact.
      const appeared = await locator.waitFor({ state: "visible", timeout: Math.max(1, visibilityDeadline - Date.now()) }).then(() => true, () => false);
      if (appeared) count = await locator.count();
    }
    if (count === 0) {
      facts.push({ id, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "MISSING" } });
      continue;
    }
    if (count > 1) {
      facts.push({ id, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "AMBIGUOUS", count } });
      continue;
    }
    let captured;
    try {
      // Hydration re-renders can detach the element between count() and evaluate(); a bounded
      // re-attach wait that ends as a MISSING fact keeps the run alive.
      captured = await locator.evaluate((element, maxChars) => (element.textContent ?? "").slice(0, maxChars + 1), ELEMENT_TEXT_LIMIT, { timeout: Math.max(1, visibilityDeadline - Date.now()) });
    } catch {
      facts.push({ id, kind: "ELEMENT_OBSERVATION", value: { expectationId: expectation.id, resolution: "MISSING" } });
      continue;
    }
    if (typeof captured !== "string") throw providerError("EVIDENCE_STORAGE_FAILED");
    const visible = expectsVisible
      ? await locator.waitFor({ state: "visible", timeout: Math.max(1, visibilityDeadline - Date.now()) }).then(() => true, () => locator.isVisible().then((state) => state === true, () => false))
      : await locator.isVisible().then((state) => state === true, () => false);
    const value = { expectationId: expectation.id, resolution: "FOUND", visible };
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

// ponytail: naive eTLD+1 (last two labels); swap in the public suffix list if a consumer ever
// runs against a co.uk-style registrable domain.
function registrableDomain(hostname) {
  if (/^[[\d]/.test(hostname)) return hostname;
  const labels = hostname.split(".");
  return labels.slice(-2).join(".");
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
  // A POLICY_VIOLATION taints everything the run sealed (e.g. a delayed click request detected at
  // cleanup), so that evidence stays withheld. Every other failure keeps the checkpoints it sealed
  // before failing: how many nodes were recorded is the primary debugging signal, and the caller
  // quarantines failed evidence as <run-dir>.invalid instead of ever treating it as success.
  const withheld = outcome.type !== "COMPLETED" && outcome.code === "POLICY_VIOLATION";
  return Object.freeze({
    outcome,
    bundles: Object.freeze(withheld ? [] : [...(runtime?.bundles ?? [])]),
    ...(!withheld && runtime?.manifest !== undefined ? { manifest: runtime.manifest } : {}),
    readBlob: withheld ? () => undefined : runtime?.readBlob ?? (() => undefined),
  });
}
