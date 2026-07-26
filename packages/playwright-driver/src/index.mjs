import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STABILIZATION = Object.freeze({ domQuietMs: 100, maxWaitMs: 2_500, ignoreUrlPatterns: [], loadingSelectorHints: [] });
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='textbox']",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");
const DESTRUCTIVE_PATTERN = /\b(pay|payment|checkout|purchase|subscribe|unsubscribe|billing|delete|remove|destroy|archive|cancel plan|confirm|send|transfer|wire|결제|구독|삭제|탈퇴|해지|확인|송금)\b/i;

/**
 * Creates a behavioral BrowserDriver backed by direct Playwright. Runtime callers only receive opaque
 * handles and observation-local element IDs; selectors and arbitrary JavaScript are never action inputs.
 */
export function createPlaywrightDriver({ browserType, browserName = "chromium", launchOptions = {}, now = () => new Date().toISOString() } = {}) {
  const sessions = new Set();

  return Object.freeze({
    async start(input = {}) {
      const BrowserType = browserType ?? await loadBrowserType(browserName);
      const started = await startSession({ input, browserType: BrowserType, launchOptions, now });
      sessions.add(started);
      return started.publicHandle;
    },
    async observe(handle) {
      const session = assertLiveSession(handle);
      return observeSession(session, now);
    },
    async execute(handle, action) {
      const session = assertLiveSession(handle);
      return executeAction(session, action, now);
    },
    async close(handle) {
      const session = assertSession(handle);
      await closeSession(session);
      sessions.delete(session);
    },
    async closeAll() {
      await Promise.all([...sessions].map(closeSession));
      sessions.clear();
    },
  });
}

async function startSession({ input, browserType, launchOptions, now }) {
  const sessionId = requiredString(input.sessionId, "sessionId");
  const environment = input.environment ?? {};
  const baseUrl = requiredString(environment.baseUrl, "environment.baseUrl");
  const startUrl = resolveStartUrl(baseUrl, environment.startPath);
  const allowedOrigins = normalizeOrigins(environment.allowedOrigins?.length ? environment.allowedOrigins : [new URL(baseUrl).origin]);
  assertAllowedOrigin(startUrl, allowedOrigins);
  const evidenceDir = path.resolve(input.evidenceDir ?? path.join(".qa", "sessions", sessionId));
  const screenshotDir = path.join(evidenceDir, "screenshots");
  const tracePath = path.join(evidenceDir, "trace.zip");
  const downloadsPath = path.join(evidenceDir, "downloads");
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(downloadsPath, { recursive: true });

  let browser;
  try {
    browser = await browserType.launch({ ...launchOptions });
    const context = await browser.newContext({
      viewport: environment.viewport ?? { width: 1280, height: 720 },
      locale: environment.locale,
      timezoneId: environment.timezoneId,
      storageState: environment.storageStatePath,
      acceptDownloads: true,
      downloadsPath,
      serviceWorkers: "block",
    });
    const runtimeIssues = [];
    let policyViolation;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (!isAllowedOrigin(url, allowedOrigins) || hasCredentials(url)) {
        policyViolation = { code: "ORIGIN_BLOCKED", message: "Blocked request outside allowedOrigins", url: safeUrl(url), method: request.method?.() };
        runtimeIssues.push(issue("network", "ORIGIN_BLOCKED", policyViolation.message, { url: safeUrl(url), method: request.method?.() }, now));
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    if (typeof context.routeWebSocket === "function") {
      await context.routeWebSocket("**/*", (socket) => {
        const socketUrl = socket.url?.() ?? "unknown";
        if (socketUrl === "unknown" || !isAllowedOrigin(socketUrl, allowedOrigins)) {
          policyViolation = { code: "ORIGIN_BLOCKED", message: "Blocked WebSocket outside allowedOrigins", url: safeUrl(socketUrl) };
          runtimeIssues.push(issue("network", "ORIGIN_BLOCKED", policyViolation.message, { url: safeUrl(socketUrl) }, now));
          socket.close();
        }
      });
    }
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (["error", "warning", "warn"].includes(message.type())) runtimeIssues.push(issue("console", message.type(), truncate(message.text(), 2_000), {}, now));
    });
    page.on("pageerror", (error) => runtimeIssues.push(issue("pageerror", "PAGE_ERROR", truncate(error.message, 2_000), {}, now)));
    page.on("requestfailed", (request) => runtimeIssues.push(issue("network", "REQUEST_FAILED", request.failure()?.errorText ?? "request failed", { url: safeUrl(request.url()), method: request.method() }, now)));
    page.on("response", (response) => {
      if (response.status() >= 400) runtimeIssues.push(issue("network", "HTTP_STATUS", `HTTP ${response.status()}`, { url: safeUrl(response.url()), status: response.status() }, now));
    });
    page.on("download", async (download) => runtimeIssues.push(issue("download", "DOWNLOAD", await download.suggestedFilename(), { url: safeUrl(download.url()) }, now)));
    page.on("popup", (popup) => {
      runtimeIssues.push(issue("browser", "POPUP", "Unexpected popup opened", { url: safeUrl(popup.url()) }, now));
      void popup.close().catch(() => undefined);
    });
    page.on("dialog", async (dialog) => {
      runtimeIssues.push(issue("browser", "DIALOG", truncate(dialog.message(), 2_000), {}, now));
      await dialog.dismiss().catch(() => undefined);
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: input.navigationTimeoutMs ?? 30_000 });
    assertCurrentOrigin(page, allowedOrigins);

    const session = {
      browser,
      context,
      page,
      sessionId,
      allowedOrigins,
      evidenceDir,
      screenshotDir,
      tracePath,
      stabilization: { ...DEFAULT_STABILIZATION, ...(input.stabilization ?? {}) },
      safetyPolicy: normalizeSafetyPolicy(input.safetyPolicy),
      fixtureRoot: input.fixtureRoot ? path.resolve(input.fixtureRoot) : undefined,
      valueRefs: input.valueRefs ?? {},
      observationSequence: 0,
      screenshotSequence: 0,
      runtimeIssues,
      policyViolation: () => policyViolation,
      setPolicyViolation(value) { policyViolation = value; },
      lastObservation: undefined,
      handles: new Map(),
      closed: false,
      publicHandle: undefined,
    };
    session.publicHandle = Object.freeze({ sessionId, __playwrightDriverSession: session });
    return session;
  } catch (error) {
    await browser?.close?.().catch(() => undefined);
    throw error;
  }
}

async function observeSession(session, now) {
  await stabilizePage(session.page, session.stabilization);
  assertCurrentOrigin(session.page, session.allowedOrigins);
  const observationId = `${session.sessionId}:obs:${++session.observationSequence}`;
  const screenshotEvidenceId = `${observationId}:screenshot:${++session.screenshotSequence}`;
  const screenshotPath = path.join(session.screenshotDir, `${session.observationSequence}.png`);
  await session.page.screenshot({ path: screenshotPath, fullPage: false });

  const capturedSemantic = await captureSemantic(session.page);
  session.handles.clear();
  capturedSemantic.interactiveElements.forEach((element) => session.handles.set(element.id, element.selector));
  const semantic = {
    ...capturedSemantic,
    interactiveElements: capturedSemantic.interactiveElements.map(({ selector: _selector, ...element }) => Object.freeze(element)),
  };
  const observation = Object.freeze({
    schemaVersion: "observation/0.1",
    id: observationId,
    sessionId: session.sessionId,
    sequence: session.observationSequence,
    timestamp: now(),
    page: {
      url: session.page.url(),
      title: await session.page.title(),
      viewport: session.page.viewportSize() ?? { width: 0, height: 0 },
    },
    semantic,
    visual: {
      screenshotEvidenceId,
      screenshotPath: path.relative(session.evidenceDir, screenshotPath),
      occludedElementFingerprints: semantic.occludedElementFingerprints,
    },
    runtime: {
      consoleIssues: session.runtimeIssues.filter((item) => item.kind === "console" || item.kind === "pageerror"),
      networkFailures: session.runtimeIssues.filter((item) => item.kind === "network"),
      downloads: session.runtimeIssues.filter((item) => item.kind === "download"),
      browserIssues: session.runtimeIssues.filter((item) => item.kind === "browser"),
      pendingRequestCount: 0,
      loadingIndicators: semantic.loadingIndicators,
      stabilizationIncomplete: false,
    },
    oracleSignals: { satisfied: [], violated: [], unknown: [] },
    evidenceIds: [screenshotEvidenceId],
  });
  session.lastObservation = observation;
  return observation;
}

async function executeAction(session, action, now) {
  if (!session.lastObservation) throw new Error("observe must be called before execute");
  const observationId = session.lastObservation.id;
  const urlBefore = session.page.url();
  try {
    assertActionAllowed(session, action);
    if (action.type === "click") {
      const target = targetFor(session, action.elementId);
      await target.click({ timeout: 10_000 });
    } else if (action.type === "type") {
      const target = targetFor(session, action.elementId);
      const value = valueFor(session, action.valueRef);
      await target.fill(value, { timeout: 10_000 });
    } else if (action.type === "select") {
      const target = targetFor(session, action.elementId);
      await target.selectOption(action.value, { timeout: 10_000 });
    } else if (action.type === "scroll") {
      await session.page.mouse.wheel(0, scrollDelta(action));
    } else if (action.type === "back") {
      await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
    } else if (action.type === "wait" || action.type === "idle") {
      await session.page.waitForTimeout(Math.min(Math.max(Number(action.durationMs) || 0, 0), 5_000));
    } else if (action.type === "observe_more" || action.type === "ignore" || action.type === "finish" || action.type === "abandon") {
      // First-class non-actions: recorded by runtime-core, no browser mutation here.
    } else {
      throw new Error(`unsupported action type: ${action?.type}`);
    }
    await stabilizePage(session.page, session.stabilization);
    assertCurrentOrigin(session.page, session.allowedOrigins);
    if (session.policyViolation()) throw new Error(session.policyViolation().code);
    const screenshotEvidenceId = `${observationId}:action:${++session.screenshotSequence}`;
    const screenshotPath = path.join(session.screenshotDir, `after-${session.screenshotSequence}.png`);
    await session.page.screenshot({ path: screenshotPath, fullPage: false });
    return Object.freeze({
      schemaVersion: "action-result/0.1",
      status: "success",
      observationId,
      action: structuredClone(action),
      urlBefore,
      urlAfter: session.page.url(),
      timestamp: now(),
      evidenceIds: [screenshotEvidenceId],
      evidence: [{ id: screenshotEvidenceId, type: "screenshot", relativePath: path.relative(session.evidenceDir, screenshotPath) }],
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: "action-result/0.1",
      status: isPolicyError(error) ? "blocked" : "failure",
      observationId,
      action: structuredClone(action),
      urlBefore,
      urlAfter: session.page.url(),
      timestamp: now(),
      evidenceIds: [],
      message: safeErrorMessage(error),
    });
  } finally {
    session.handles.clear();
    session.lastObservation = undefined;
  }
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  try {
    await session.context.tracing.stop({ path: session.tracePath });
  } catch {
    await rm(session.tracePath, { force: true }).catch(() => undefined);
  }
  await session.context.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
}

async function stabilizePage(page, policy) {
  await page.waitForLoadState("domcontentloaded", { timeout: policy.maxWaitMs }).catch(() => undefined);
  await page.waitForFunction((quietMs) => new Promise((resolve) => {
    let timer = setTimeout(resolve, quietMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resolve, quietMs);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, Math.max(quietMs, quietMs * 3));
  }), policy.domQuietMs, { timeout: policy.maxWaitMs }).catch(() => undefined);
}

async function captureSemantic(page) {
  const data = await page.locator("body").evaluate((body, selector) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const roleOf = (element) => element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: inputRole(element), TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" }[element.tagName] ?? "generic");
    const nameOf = (element) => normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.value || element.getAttribute("alt") || element.getAttribute("name"));
    const visible = (element, rect) => {
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01;
    };
    const inViewport = (rect) => rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const topOwnsPoint = (element, rect) => {
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      return top === element || element.contains(top);
    };
    const fingerprint = (element, role, name, rect) => [role, name, element.id || "", element.getAttribute("data-testid") || element.getAttribute("data-test") || "", location.pathname, Math.round(rect.top), Math.round(rect.left)].join("|");
    const node = (element) => ({ role: roleOf(element), name: nameOf(element), text: normalize(element.innerText || element.textContent).slice(0, 500) });
    const headings = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")].map(node).filter((item) => item.text || item.name).slice(0, 32);
    const landmarks = [...body.querySelectorAll("main,nav,header,footer,aside,section,[role='main'],[role='navigation'],[role='banner'],[role='contentinfo']")].map(node).filter((item) => item.text || item.name).slice(0, 32);
    const visibleText = normalize(body.innerText).split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 80);
    const loadingIndicators = [...body.querySelectorAll("[aria-busy='true'],[role='progressbar'],.loading,.spinner")].map((element) => normalize(element.innerText || element.getAttribute("aria-label") || element.className)).filter(Boolean).slice(0, 16);
    const elements = [];
    const occluded = [];
    [...body.querySelectorAll(selector)].slice(0, 256).forEach((element, selectorOrdinal) => {
      const rect = element.getBoundingClientRect();
      const role = roleOf(element);
      const name = nameOf(element);
      const isVisible = visible(element, rect);
      const viewportVisible = isVisible && inViewport(rect);
      const occludedByOtherElement = viewportVisible && !topOwnsPoint(element, rect);
      const item = {
        selectorOrdinal,
        role,
        name,
        text: normalize(element.innerText || element.value || element.textContent).slice(0, 500),
        enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
        focused: document.activeElement === element,
        viewportVisible,
        occluded: occludedByOtherElement,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        fingerprint: fingerprint(element, role, name, rect),
      };
      if (isVisible && viewportVisible && !occludedByOtherElement && (name || item.text || ["button", "link", "textbox", "combobox"].includes(role))) elements.push(item);
      else if (occludedByOtherElement) occluded.push(item.fingerprint);
    });
    return { visibleText, headings, landmarks, interactiveElements: elements.slice(0, 128), occludedElementFingerprints: occluded.slice(0, 128), loadingIndicators };

    function inputRole(element) {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "search", "slider"].includes(type)) return type === "submit" ? "button" : type;
      return "textbox";
    }
  }, INTERACTIVE_SELECTOR);
  return {
    visibleText: data.visibleText,
    headings: data.headings,
    landmarks: data.landmarks,
    interactiveElements: data.interactiveElements.map((element, index) => {
      const { selectorOrdinal, ...publicElement } = element;
      return { ...publicElement, id: `el_${index + 1}`, selector: `${INTERACTIVE_SELECTOR} >> nth=${selectorOrdinal}` };
    }),
    occludedElementFingerprints: data.occludedElementFingerprints,
    loadingIndicators: data.loadingIndicators,
  };
}

function assertActionAllowed(session, action) {
  if (!action || typeof action.type !== "string") throw policyError("ACTION_NOT_ALLOWED", "Invalid action");
  assertCurrentOrigin(session.page, session.allowedOrigins);
  const policy = session.safetyPolicy;
  const element = action.elementId ? session.lastObservation.semantic.interactiveElements.find((item) => item.id === action.elementId) : undefined;
  if (["click", "type", "select", "ignore"].includes(action.type) && !element) throw policyError("ELEMENT_NOT_FOUND", "Element was not in the latest perceived observation");
  if (element && (!element.viewportVisible || element.occluded)) throw policyError("ACTION_NOT_ALLOWED", "Element is not visible to the persona");
  if (element && !element.enabled && ["click", "type", "select"].includes(action.type)) throw policyError("ACTION_NOT_ALLOWED", "Element is disabled");
  if ((action.type === "click" || action.type === "back") && !policy.allowClick) throw policyError("ACTION_NOT_ALLOWED", "Click/back actions are blocked by policy");
  if (action.type === "type" && !policy.allowTyping) throw policyError("ACTION_NOT_ALLOWED", "Typing is blocked by policy");
  if (action.type === "select" && !policy.allowTyping) throw policyError("ACTION_NOT_ALLOWED", "Select is blocked by policy");
  if (action.type === "scroll" && !policy.allowNavigation) throw policyError("ACTION_NOT_ALLOWED", "Scrolling is blocked by policy");
  if (element && policy.stopBeforeConfirmation && DESTRUCTIVE_PATTERN.test(`${element.role} ${element.name} ${element.text} ${action.reasonCode ?? ""}`)) throw policyError("ACTION_NOT_ALLOWED", "Destructive confirmation/payment action blocked");
}

function targetFor(session, elementId) {
  const selector = session.handles.get(elementId);
  if (!selector) throw policyError("ELEMENT_NOT_FOUND", "Observed element handle is unavailable");
  return session.page.locator(selector);
}

function valueFor(session, valueRef) {
  if (!valueRef || typeof valueRef !== "string" || !(valueRef in session.valueRefs)) throw policyError("ACTION_NOT_ALLOWED", "Typing requires a configured valueRef");
  return String(session.valueRefs[valueRef]);
}

function normalizeSafetyPolicy(policy = {}) {
  return {
    allowRead: policy.allowRead !== false,
    allowNavigation: policy.allowNavigation !== false,
    allowClick: policy.allowClick !== false,
    allowTyping: policy.allowTyping === true,
    allowFileUpload: policy.allowFileUpload === true,
    allowStateMutation: policy.allowStateMutation === true,
    allowExternalOrigin: policy.allowExternalOrigin === true,
    forbiddenActions: Array.isArray(policy.forbiddenActions) ? policy.forbiddenActions : ["payment", "subscription_change", "account_delete", "data_delete", "send_message", "confirm_destructive"],
    stopBeforeConfirmation: policy.stopBeforeConfirmation !== false,
  };
}

async function loadBrowserType(browserName) {
  const mod = await import("@playwright/test");
  const type = mod[browserName];
  if (!type?.launch) throw new Error(`Unknown Playwright browser type: ${browserName}`);
  return type;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function resolveStartUrl(baseUrl, startPath = "/") {
  return new URL(startPath, baseUrl).toString();
}

function normalizeOrigins(origins) {
  return origins.map((origin) => new URL(origin).origin);
}

function assertAllowedOrigin(url, allowedOrigins) {
  if (!isAllowedOrigin(url, allowedOrigins)) throw policyError("ORIGIN_BLOCKED", "URL is outside allowedOrigins");
}

function assertCurrentOrigin(page, allowedOrigins) {
  assertAllowedOrigin(page.url(), allowedOrigins);
}

function isAllowedOrigin(url, allowedOrigins) {
  try { return allowedOrigins.includes(new URL(url).origin); } catch { return false; }
}

function hasCredentials(url) {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return true;
  }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?…" : "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function issue(kind, code, message, metadata, now) {
  return Object.freeze({ id: `issue-${hash({ kind, code, message, metadata }).slice(0, 12)}`, kind, code, message, metadata, timestamp: now() });
}

function scrollDelta(action) {
  const amount = { small: 250, medium: 700, large: 1_400 }[action.amount] ?? 700;
  return action.direction === "up" ? -amount : amount;
}

function assertSession(handle) {
  const session = handle?.__playwrightDriverSession;
  if (!session) throw new TypeError("invalid playwright driver handle");
  return session;
}

function assertLiveSession(handle) {
  const session = assertSession(handle);
  if (session.closed) throw new Error("playwright driver session is closed");
  return session;
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPolicyError(error) {
  return ["ACTION_NOT_ALLOWED", "ELEMENT_NOT_FOUND", "ORIGIN_BLOCKED"].includes(error?.code) || ["ACTION_NOT_ALLOWED", "ELEMENT_NOT_FOUND", "ORIGIN_BLOCKED"].includes(error?.message);
}

function safeErrorMessage(error) {
  if (isPolicyError(error)) return error.message;
  return "Browser action failed";
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
