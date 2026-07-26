import {
  EXECUTION_ACTION_RESULT_VERSION,
  RUNTIME_OUTCOME_VERSION,
  canonicalHash,
  snapshotContract,
  validateContract,
} from "../contracts/index.mjs";
import {
  advanceAdaptiveMilestone,
  createAdaptiveActionAuthorizer,
  executePlan,
  providerCapabilities,
  validateExecutionPlanBinding,
} from "../core/index.mjs";
import { createInMemoryEvidenceStore, redactSensitiveText } from "../evidence/index.mjs";

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
const GATEWAY_PROVIDER_ID = "playwright-browser-tool-gateway";
const GATEWAY_PROVIDER_VERSION = "0.1.0";
const GATEWAY_DOM_LIMIT = 1024 * 1024;
const GATEWAY_ARIA_LIMIT = 512 * 1024;
const GATEWAY_MAX_ELEMENTS = 128;
const GATEWAY_ELEMENT_TEXT_LIMIT = 1024;
const GATEWAY_CLEANUP_TIMEOUT_MS = 1_000;
const GATEWAY_ACTIONS = Object.freeze(["get_current_url", "observe_dom", "observe_aria", "navigate", "go_back", "reload_page", "click_observed_element", "press_key", "hover_observed_element", "scroll_view", "wait_for_element_state"]);

export function playwrightExecutionCapabilities() {
  return providerCapabilities({
    providerId: PROVIDER_ID,
    actions: ["NAVIGATE", "CLICK", "OBSERVE", "CHECKPOINT"],
    evidence: ["VISIBLE_TEXT", "DOM_SNAPSHOT", "ACTION_LOG", "ELEMENT_OBSERVATION"],
  });
}

export function playwrightBrowserToolCapabilities() {
  return providerCapabilities({
    providerId: GATEWAY_PROVIDER_ID,
    actions: [...GATEWAY_ACTIONS],
    evidence: ["DOM_SNAPSHOT", "ARIA_SNAPSHOT", "ACTION_LOG"],
  });
}

export async function openPlaywrightBrowserToolGateway({
  input,
  browserName = "chromium",
  browserType,
  viewport = { width: 1280, height: 720 },
  secrets = [],
  clock = Date.now,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof clock !== "function" || typeof now !== "function") throw new TypeError("clock and now must be functions");
  if (!Array.isArray(secrets)) throw new TypeError("secrets must be an array");
  const initialInput = snapshotContract("ExecutionAgentInput", redactGatewayValue(snapshotContract("ExecutionAgentInput", input), secrets));
  const deadline = readFiniteClock(clock) + initialInput.remainingBudget.timeMs;
  const capabilities = playwrightBrowserToolCapabilities();
  const store = createInMemoryEvidenceStore({ providerCapabilities: capabilities, producer: { name: GATEWAY_PROVIDER_ID, version: GATEWAY_PROVIDER_VERSION }, secrets });
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
  let policyViolation = false;
  try {
    context = await runGatewayBrowserOperation({ deadline, clock }, () => browser.newContext({ viewport: { ...viewport }, serviceWorkers: "block" }));
    if (typeof context.route !== "function" || typeof context.routeWebSocket !== "function") throw new Error("browser context cannot enforce gateway policy");
    await runGatewayBrowserOperation({ deadline, clock }, () => context.route("**/*", async (route) => {
      try {
        const request = route.request();
        const url = new URL(request.url());
        if (interactionStarted || !["GET", "HEAD"].includes(request.method()) || !initialInput.capabilityLease.allowedOrigins.includes(url.origin) || url.username || url.password) {
          policyViolation = true;
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      } catch {
        policyViolation = true;
        await route.abort("blockedbyclient");
      }
    }));
    await runGatewayBrowserOperation({ deadline, clock }, () => context.routeWebSocket("**/*", (socket) => {
      policyViolation = true;
      socket.close();
    }));
    const page = await runGatewayBrowserOperation({ deadline, clock }, () => context.newPage());
    await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goto(initialInput.currentPage.url, { waitUntil: "domcontentloaded", timeout }));
    assertGatewayOrigin(page, initialInput.capabilityLease.allowedOrigins);
    policyViolation = false;

    let currentPage = { ...initialInput.currentPage, url: gatewayUrl(page, initialInput.capabilityLease.allowedOrigins) };
    let remainingBudget = { ...initialInput.remainingBudget };
    let milestones = structuredClone(initialInput.milestones);
    let currentMilestoneId = initialInput.currentMilestoneId;
    let outcome;
    let recentObservations = [];
    let manifest;
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
      if (!GATEWAY_ACTIONS.includes(proposal?.action)) throw new Error("browser tool is not implemented by this gateway slice");
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
        if (authorization.proposal.action === "get_current_url") {
          // URL is captured in the mandatory pre/post evidence.
        } else if (authorization.proposal.action === "navigate") {
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goto(authorization.proposal.parameters.url, { waitUntil: "domcontentloaded", timeout }));
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "go_back") {
          const response = await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.goBack({ waitUntil: "domcontentloaded", timeout }));
          if (response === null) throw new Error("browser history has no previous page");
          invalidateGatewayObservations();
        } else if (authorization.proposal.action === "reload_page") {
          await runGatewayBrowserOperation({ deadline, clock }, (timeout) => page.reload({ waitUntil: "domcontentloaded", timeout }));
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
        }
        if (policyViolation) throw new Error("browser tool policy was violated");
        const nextUrl = gatewayUrl(page, initialInput.capabilityLease.allowedOrigins);
        if (["navigate", "go_back", "reload_page"].includes(authorization.proposal.action) || nextUrl !== currentPage.url) {
          currentPage = { pageId: `page-${canonicalHash({ proposalId: authorization.proposal.proposalId, nextUrl }).slice("sha256:".length, "sha256:".length + 12)}`, domGeneration: 1, url: nextUrl };
          recentObservations = [];
          handles.clear();
        }
        const after = await captureGatewayPage(page, currentPage, initialInput.capabilityLease.allowedOrigins, { deadline, clock }, secrets);
        if (policyViolation) throw new Error("browser tool policy was violated");
        currentPage.url = after.page.url;
        remainingBudget.timeMs = Math.min(remainingBudget.timeMs, Math.max(0, Math.floor(deadline - readFiniteClock(clock))));
        const artifacts = captureGatewayArtifacts(store, authorization.proposal, before, after);
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
          milestones = milestones.map((item) => item.id === beforeInput.currentMilestoneId ? { ...item, status: "COMPLETED" } : item);
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

async function observeGatewayElements({ page, input, currentPage, sequence, secrets, deadline, clock }) {
  const locator = page.locator("button, [role='button'], [role='menuitem'], dialog, [role='dialog'], a[href], input, select, textarea, [tabindex]");
  const timing = { deadline, clock };
  const count = await runGatewayBrowserOperation(timing, () => locator.count());
  if (!Number.isInteger(count) || count < 0 || count > GATEWAY_MAX_ELEMENTS) throw new Error("gateway element observation exceeds its bound");
  const observationId = `observation-${canonicalHash({ runId: input.runId, scenarioId: input.scenarioId, pageId: currentPage.pageId, domGeneration: currentPage.domGeneration, sequence }).slice("sha256:".length, "sha256:".length + 16)}`;
  const elements = [];
  const handles = new Map();
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
    },
    handles,
  };
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

function captureGatewayArtifacts(store, proposal, before, after) {
  const auditProposal = structuredClone(proposal);
  if (auditProposal.action === "navigate") {
    const url = new URL(auditProposal.parameters.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    auditProposal.parameters.url = url.href;
  }
  return [
    store.captureArtifact({ id: `${proposal.proposalId}:before:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: before.dom }),
    store.captureArtifact({ id: `${proposal.proposalId}:before:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: before.aria }),
    store.captureArtifact({ id: `${proposal.proposalId}:action`, type: "ACTION_LOG", contentType: "application/json", content: JSON.stringify({ proposal: auditProposal, status: "ACCEPTED", before: before.page, after: after.page }) }),
    store.captureArtifact({ id: `${proposal.proposalId}:after:dom`, type: "DOM_SNAPSHOT", contentType: "text/html", content: after.dom }),
    store.captureArtifact({ id: `${proposal.proposalId}:after:aria`, type: "ARIA_SNAPSHOT", contentType: "text/plain", content: after.aria }),
  ];
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

export async function runAdaptiveWithPlaywright({
  input,
  proposeAction,
  browserName = "chromium",
  browserType,
  viewport,
  secrets = [],
  now = () => new Date().toISOString(),
  clock = Date.now,
} = {}) {
  if (typeof proposeAction !== "function") throw new Error("proposeAction must be a function");
  const gateway = await openPlaywrightBrowserToolGateway({ input, browserName, browserType, viewport, secrets, now, clock });
  const bundles = [];
  let manifest;
  let outcome;
  try {
    while (outcome === undefined) {
      const proposerInput = gateway.agentInput();
      const proposed = await runGatewayBrowserOperation({ deadline: readFiniteClock(clock) + proposerInput.remainingBudget.timeMs, clock }, () => proposeAction(proposerInput));
      if (!proposed?.proposal || typeof proposed.proposal !== "object") throw new Error("adaptive proposer must return a proposal and token usage");
      if (!Number.isInteger(proposed.tokensUsed) || proposed.tokensUsed < 0) throw new Error("adaptive proposer token usage must be a non-negative integer");
      const execution = await gateway.execute({ proposal: proposed.proposal, tokensUsed: proposed.tokensUsed });
      bundles.push(execution.bundle);
      manifest = execution.manifest;
      outcome = execution.outcome;
    }
    return Object.freeze({ outcome, bundles: Object.freeze(bundles), manifest, readBlob: gateway.readBlob });
  } finally {
    await gateway.close();
  }
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
