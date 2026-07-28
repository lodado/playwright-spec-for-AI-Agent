import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
const FORBIDDEN_ACTION_PATTERNS = Object.freeze({
  payment: /\b(pay|payment|checkout|purchase|billing|transfer|wire|결제|송금)\b/i,
  subscription_change: /\b(subscribe|unsubscribe|subscription|cancel plan|구독|해지)\b/i,
  account_delete: /\b(delete|remove|close)\s+(my\s+)?account\b|\b(account_delete|탈퇴)\b/i,
  data_delete: /\b(delete|remove|destroy|archive)\b|\b(data_delete|삭제)\b/i,
  send_message: /\b(send|submit)\s+(message|email|mail)\b|\bsend_message\b/i,
  confirm_destructive: DESTRUCTIVE_PATTERN,
});

function normalizeAuthBootstrap(value, baseUrl) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["url", "allowedOrigins", "allowedEndpoints"].includes(key)) || typeof value.url !== "string") throw new TypeError("environment.auth.bootstrap is invalid");
  const base = new URL(baseUrl);
  const url = bootstrapUrl(value.url);
  if (value.allowedOrigins !== undefined && !Array.isArray(value.allowedOrigins)) throw new TypeError("environment.auth.bootstrap is invalid");
  if (value.allowedEndpoints !== undefined && !Array.isArray(value.allowedEndpoints)) throw new TypeError("environment.auth.bootstrap is invalid");
  const allowedOrigins = [...new Set([base.origin, url.origin, ...(value.allowedOrigins ?? [])].map(bootstrapOrigin))];
  const allowedEndpoints = (value.allowedEndpoints ?? []).map((endpoint) => normalizeBootstrapEndpoint(endpoint, allowedOrigins));
  return Object.freeze({ url: url.href, allowedOrigins: Object.freeze(allowedOrigins), allowedEndpoints: Object.freeze(allowedEndpoints) });
}

function bootstrapAllowsRequest(bootstrap, requestUrl, method) {
  if (!["http:", "https:"].includes(requestUrl.protocol) || requestUrl.username || requestUrl.password) return false;
  if (["GET", "HEAD"].includes(method)) return bootstrap.allowedOrigins.includes(requestUrl.origin);
  return bootstrap.allowedEndpoints.some((endpoint) => endpoint.origin === requestUrl.origin && endpoint.path === requestUrl.pathname && endpoint.methods.includes(method));
}

function bootstrapUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("environment.auth.bootstrap is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("environment.auth.bootstrap is invalid");
  return url;
}

function bootstrapOrigin(value) {
  const url = bootstrapUrl(value);
  if (url.pathname !== "/") throw new TypeError("environment.auth.bootstrap is invalid");
  return url.origin;
}

function normalizeBootstrapEndpoint(value, allowedOrigins) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["origin", "path", "methods"].includes(key))) throw new TypeError("environment.auth.bootstrap is invalid");
  const origin = bootstrapOrigin(value.origin);
  if (!allowedOrigins.includes(origin) || typeof value.path !== "string" || !/^\/[^?#]*$/.test(value.path) || !Array.isArray(value.methods) || value.methods.length === 0) throw new TypeError("environment.auth.bootstrap is invalid");
  const methods = [...new Set(value.methods)];
  if (methods.some((method) => !["POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new TypeError("environment.auth.bootstrap is invalid");
  return Object.freeze({ origin, path: value.path, methods: Object.freeze(methods) });
}

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
      const result = await closeSession(session);
      sessions.delete(session);
      return result;
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
  const baseUrl = httpUrl(requiredString(environment.baseUrl, "environment.baseUrl"), "environment.baseUrl");
  const startUrl = resolveStartUrl(baseUrl, environment.startPath);
  const allowedOrigins = normalizeOrigins(environment.allowedOrigins?.length ? environment.allowedOrigins : [new URL(baseUrl).origin]);
  assertAllowedOrigin(startUrl, allowedOrigins);
  const baseOrigin = new URL(baseUrl).origin;
  const authBootstrap = normalizeAuthBootstrap(environment.auth?.bootstrap, baseUrl);
  const safetyPolicy = normalizeSafetyPolicy(input.safetyPolicy);
  const navigationOrigins = safetyPolicy.allowExternalOrigin ? allowedOrigins : [baseOrigin];
  assertAllowedOrigin(startUrl, navigationOrigins);
  const valueRefs = input.valueRefs ?? {};
  const secretValues = Object.values(valueRefs).filter((value) => typeof value === "string" && value.length > 0);
  const requestedEvidencePolicy = normalizeEvidencePolicy(input.evidencePolicy ?? input.study?.evidence);
  const evidencePolicy = secretValues.length > 0
    ? { ...requestedEvidencePolicy, screenshot: "off", trace: false, video: "off" }
    : requestedEvidencePolicy;
  const storageState = environment.storageStatePath ? await resolveStorageStatePath(environment.storageStatePath) : undefined;
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
      storageState,
      acceptDownloads: true,
      downloadsPath,
      serviceWorkers: "block",
      ...(evidencePolicy.video === "off" ? {} : { recordVideo: { dir: path.join(evidenceDir, "videos") } }),
    });
  const runtimeIssues = [];
  const makeIssue = (kind, code, message, metadata = {}) => issue(kind, code, message, metadata, now, secretValues);
    const responseContentTypes = new Map();
    let policyViolation;
    let actionInProgress = false;
    let initialNavigationComplete = false;
    let bootstrapActive = authBootstrap !== undefined;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method?.() ?? "GET";
      const isNavigation = request.isNavigationRequest?.() === true;
      let violation;
      if (bootstrapActive) {
        if (bootstrapAllowsRequest(authBootstrap, new URL(url), method.toUpperCase())) await route.continue();
        else await route.abort("blockedbyclient");
        return;
      } else if (initialNavigationComplete && isNavigation && !safetyPolicy.allowNavigation) {
        violation = { code: "ACTION_NOT_ALLOWED", message: "Navigation is blocked by policy" };
      } else if (initialNavigationComplete && isNavigation && !isAllowedOrigin(url, navigationOrigins)) {
        violation = { code: "ORIGIN_BLOCKED", message: "External-origin navigation is blocked by policy" };
      }
      if (violation) {
        if (actionInProgress) policyViolation = { ...violation, url: safeUrl(url, secretValues), method };
      runtimeIssues.push(makeIssue("network", violation.code, violation.message, { url: safeUrl(url, secretValues), method }));
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  if (evidencePolicy.trace) await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
    const page = await context.newPage();
    page.on("console", (message) => {
    if (["error", "warning", "warn"].includes(message.type())) runtimeIssues.push(makeIssue("console", message.type(), truncate(message.text(), 2_000)));
    });
  page.on("pageerror", (error) => runtimeIssues.push(makeIssue("pageerror", "PAGE_ERROR", truncate(error.message, 2_000))));
  page.on("requestfailed", (request) => runtimeIssues.push(makeIssue("network", "REQUEST_FAILED", request.failure()?.errorText ?? "request failed", { url: safeUrl(request.url(), secretValues), method: request.method() })));
    page.on("response", (response) => {
      const metadata = { url: safeUrl(response.url(), secretValues), method: response.request().method(), status: response.status() };
      responseContentTypes.set(response.url(), response.headers()["content-type"]);
    runtimeIssues.push(makeIssue("network", response.status() >= 400 ? "HTTP_STATUS" : "HTTP_RESPONSE", `HTTP ${response.status()}`, metadata));
    });
    page.on("download", async (download) => {
      const filename = await download.suggestedFilename();
    runtimeIssues.push(makeIssue("download", "DOWNLOAD", filename, { url: safeUrl(download.url(), secretValues), filename, mimeType: responseContentTypes.get(download.url()) }));
    });
    page.on("popup", (popup) => {
    runtimeIssues.push(makeIssue("popup", "POPUP", "Unexpected popup opened", { url: safeUrl(popup.url(), secretValues) }));
      void popup.close().catch(() => undefined);
    });
    page.on("dialog", async (dialog) => {
    runtimeIssues.push(makeIssue("dialog", "DIALOG", truncate(dialog.message(), 2_000)));
      await dialog.dismiss().catch(() => undefined);
    });
    if (authBootstrap !== undefined) {
      await page.goto(authBootstrap.url, { waitUntil: "domcontentloaded", timeout: input.navigationTimeoutMs ?? 30_000 });
      bootstrapActive = false;
    }
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: input.navigationTimeoutMs ?? 30_000 });
    initialNavigationComplete = true;
    assertCurrentOrigin(page, navigationOrigins);

    const session = {
      browser,
      context,
      page,
      sessionId,
      allowedOrigins,
      navigationOrigins,
      evidenceDir,
      screenshotDir,
      tracePath,
      stabilization: { ...DEFAULT_STABILIZATION, ...(input.stabilization ?? {}) },
      safetyPolicy,
      evidencePolicy,
      fixtureRoot: input.fixtureRoot ? path.resolve(input.fixtureRoot) : undefined,
    valueRefs,
    secretValues,
      observationSequence: 0,
      screenshotSequence: 0,
      hadFailure: false,
      runtimeIssues,
      policyViolation: () => policyViolation,
      beginAction(trackPolicyViolation) {
        policyViolation = undefined;
        actionInProgress = trackPolicyViolation;
      },
      endAction() {
        actionInProgress = false;
        policyViolation = undefined;
      },
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
  if (!session.safetyPolicy.allowRead) throw policyError("ACTION_NOT_ALLOWED", "Reading the page is blocked by policy");
  await stabilizePage(session.page, session.stabilization);
  assertCurrentOrigin(session.page, session.navigationOrigins);
  const observationId = `${session.sessionId}:obs:${++session.observationSequence}`;
  let screenshotEvidence;
  if (session.evidencePolicy.screenshot === "every_action") {
    const screenshotEvidenceId = `${observationId}:screenshot:${++session.screenshotSequence}`;
    const screenshotPath = path.join(session.screenshotDir, `${session.observationSequence}.png`);
    await captureScreenshot(session, screenshotPath);
    screenshotEvidence = await fileEvidence(screenshotEvidenceId, "screenshot", screenshotPath, session.evidenceDir);
  }
  const runtimeEvidence = session.runtimeIssues.map(runtimeIssueEvidence);

  const capturedSemantic = redactDeep(await captureSemantic(session.page), session.secretValues);
  await clearHandles(session);
  for (const element of capturedSemantic.interactiveElements) {
    const handle = await session.page.locator(element.selector).elementHandle();
    if (handle) session.handles.set(element.id, { handle, role: element.role, name: element.name, fingerprint: element.fingerprint });
  }
  const semantic = {
    visibleText: capturedSemantic.visibleText,
    headings: capturedSemantic.headings,
    landmarks: capturedSemantic.landmarks,
    interactiveElements: capturedSemantic.interactiveElements.map(({ selector: _selector, ...element }) => Object.freeze(element)),
  };
  const observation = Object.freeze({
    schemaVersion: "observation/0.1",
    id: observationId,
    sessionId: session.sessionId,
    sequence: session.observationSequence,
    timestamp: now(),
    page: {
      url: safeUrl(session.page.url(), session.secretValues),
      title: redactSecrets(await session.page.title(), session.secretValues),
      viewport: session.page.viewportSize() ?? { width: 0, height: 0 },
    },
    semantic,
    visual: {
      ...(screenshotEvidence ? { screenshotEvidenceId: screenshotEvidence.id } : {}),
      occludedElementFingerprints: capturedSemantic.occludedElementFingerprints,
    },
    runtime: {
      consoleIssues: session.runtimeIssues.filter((item) => item.type === "console" || item.type === "pageerror"),
      networkFailures: session.runtimeIssues.filter((item) => item.type === "network"),
      pendingRequestCount: 0,
      loadingIndicators: capturedSemantic.loadingIndicators,
    },
    oracleSignals: { satisfied: [], violated: [], unknown: [] },
    evidence: [...(screenshotEvidence ? [screenshotEvidence] : []), ...runtimeEvidence],
  });
  session.lastObservation = observation;
  return observation;
}

async function executeAction(session, action, now) {
  if (!session.lastObservation) throw new Error("observe must be called before execute");
  const observationId = session.lastObservation.id;
  const urlBefore = safeUrl(session.page.url(), session.secretValues);
  let actionTarget;
  try {
    actionTarget = await assertActionAllowed(session, action);
    session.beginAction(["click", "type", "select", "scroll", "back"].includes(action.type));
    if (action.type === "click") {
      await actionTarget.handle.click({ timeout: 10_000 });
    } else if (action.type === "type") {
      const value = valueFor(session, action.valueRef);
      await actionTarget.handle.fill(value, { timeout: 10_000 });
    } else if (action.type === "select") {
      await actionTarget.handle.selectOption(action.value, { timeout: 10_000 });
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
    assertCurrentOrigin(session.page, session.navigationOrigins);
    if (session.policyViolation()) throw policyError(session.policyViolation().code, session.policyViolation().message);
    let screenshotEvidence;
    if (session.evidencePolicy.screenshot === "every_action") {
      const screenshotEvidenceId = `${observationId}:action:${++session.screenshotSequence}`;
      const screenshotPath = path.join(session.screenshotDir, `after-${session.screenshotSequence}.png`);
      await captureScreenshot(session, screenshotPath);
      screenshotEvidence = await fileEvidence(screenshotEvidenceId, "screenshot", screenshotPath, session.evidenceDir);
    }
    return Object.freeze({
      schemaVersion: "action-result/0.1",
      status: "success",
      observationId,
      action: structuredClone(action),
      urlBefore,
      urlAfter: safeUrl(session.page.url(), session.secretValues),
      timestamp: now(),
      evidenceIds: screenshotEvidence ? [screenshotEvidence.id] : [],
      evidence: screenshotEvidence ? [screenshotEvidence] : [],
    });
  } catch (error) {
    session.hadFailure = true;
    const failureEvidence = session.evidencePolicy.screenshot === "off" ? [] : await captureFailureScreenshot(session, observationId);
    return Object.freeze({
      schemaVersion: "action-result/0.1",
      status: isPolicyError(error) ? "blocked" : "failure",
      code: isPolicyError(error) ? error.code : "DRIVER_ACTION_FAILED",
      observationId,
      action: structuredClone(action),
      urlBefore,
      urlAfter: safeUrl(session.page.url(), session.secretValues),
      timestamp: now(),
      evidenceIds: failureEvidence.map(item => item.id),
      evidence: failureEvidence,
      message: safeErrorMessage(error),
    });
  } finally {
    session.endAction();
    await actionTarget?.handle?.dispose?.().catch(() => undefined);
    await clearHandles(session);
    session.lastObservation = undefined;
  }
}

async function closeSession(session) {
  if (session.closed) return { evidence: [] };
  session.closed = true;
  let closeError;
  let traceEvidence;
  let videoEvidence;
  const video = session.page.video?.();
  if (session.evidencePolicy.trace) {
    try {
      await session.context.tracing.stop({ path: session.tracePath });
      traceEvidence = await fileEvidence(`${session.sessionId}:trace`, "trace", session.tracePath, session.evidenceDir);
    } catch (error) {
      closeError = error;
      await rm(session.tracePath, { force: true }).catch(() => undefined);
    }
  }
  try { await session.context.close(); } catch (error) { closeError ??= error; }
  if (video) {
    try {
      const videoPath = await video.path();
      if (session.evidencePolicy.video === "all" || session.hadFailure) {
        videoEvidence = await fileEvidence(`${session.sessionId}:video`, "video", videoPath, session.evidenceDir);
      } else {
        await rm(videoPath, { force: true });
      }
    } catch (error) { closeError ??= error; }
  }
  try { await session.browser.close(); } catch (error) { closeError ??= error; }
  if (closeError) throw closeError;
  return { evidence: [traceEvidence, videoEvidence].filter(Boolean) };
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
    const nameOf = (element) => normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.getAttribute("alt") || element.getAttribute("name"));
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
    const viewportText = (root) => {
      const parts = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
        const parent = textNode.parentElement;
        if (!parent || !normalize(textNode.data)) continue;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.01) continue;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        if ([...range.getClientRects()].some((rect) => inViewport(rect) && topOwnsPoint(parent, rect))) parts.push(textNode.data);
      }
      return normalize(parts.join(" "));
    };
    const node = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        role: roleOf(element),
        name: nameOf(element),
        text: viewportText(element).slice(0, 500),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewportPosition: { inViewport: visible(element, rect) && inViewport(rect), occluded: !topOwnsPoint(element, rect) },
      };
    };
    const headings = [...body.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")].map(node).filter((item) => item.viewportPosition.inViewport && !item.viewportPosition.occluded && (item.text || item.name)).slice(0, 32);
    const landmarks = [...body.querySelectorAll("main,nav,header,footer,aside,section,[role='main'],[role='navigation'],[role='banner'],[role='contentinfo']")].map(node).filter((item) => item.viewportPosition.inViewport && !item.viewportPosition.occluded && (item.text || item.name)).slice(0, 32);
    const visibleText = viewportText(body).split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean).slice(0, 80);
    const loadingIndicators = [...body.querySelectorAll("[aria-busy='true'],[role='progressbar'],.loading,.spinner")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return visible(element, rect) && inViewport(rect);
    }).map((element) => normalize(element.innerText || element.getAttribute("aria-label") || element.className)).filter(Boolean).slice(0, 16);
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
        text: normalize(element.innerText || element.textContent).slice(0, 500),
        checked: ["checkbox", "radio"].includes(role) ? Boolean(element.checked) : undefined,
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
      return {
        id: `el_${index + 1}`,
        role: publicElement.role,
        name: publicElement.name,
        text: publicElement.text,
        ...(publicElement.checked === undefined ? {} : { checked: publicElement.checked }),
        enabled: publicElement.enabled,
        focused: publicElement.focused,
        visible: publicElement.viewportVisible && !publicElement.occluded,
        viewportPosition: { inViewport: publicElement.viewportVisible, occluded: publicElement.occluded },
        boundingBox: publicElement.boundingBox,
        fingerprint: publicElement.fingerprint,
        selector: `${INTERACTIVE_SELECTOR} >> nth=${selectorOrdinal}`,
      };
    }),
    occludedElementFingerprints: data.occludedElementFingerprints,
    loadingIndicators: data.loadingIndicators,
  };
}

async function assertActionAllowed(session, action) {
  if (!action || typeof action.type !== "string") throw policyError("ACTION_NOT_ALLOWED", "Invalid action");
  assertCurrentOrigin(session.page, session.navigationOrigins);
  const policy = session.safetyPolicy;
  const element = action.elementId ? session.lastObservation.semantic.interactiveElements.find((item) => item.id === action.elementId) : undefined;
  if (["click", "type", "select", "ignore"].includes(action.type) && !element) throw policyError("ELEMENT_NOT_FOUND", "Element was not in the latest perceived observation");
  if (element && (!element.visible || !element.viewportPosition?.inViewport || element.viewportPosition?.occluded)) throw policyError("ACTION_NOT_ALLOWED", "Element is not visible to the persona");
  if (element && !element.enabled && ["click", "type", "select"].includes(action.type)) throw policyError("ACTION_NOT_ALLOWED", "Element is disabled");
  if ((action.type === "click" || action.type === "back") && !policy.allowClick) throw policyError("ACTION_NOT_ALLOWED", "Click/back actions are blocked by policy");
  if (action.type === "type" && !policy.allowTyping) throw policyError("ACTION_NOT_ALLOWED", "Typing is blocked by policy");
  if (action.type === "select" && !policy.allowTyping) throw policyError("ACTION_NOT_ALLOWED", "Select is blocked by policy");
  if (action.type === "back" && !policy.allowNavigation) throw policyError("ACTION_NOT_ALLOWED", "Navigation is blocked by policy");
  if (policy.forbiddenActions.includes(action.reasonCode)) throw policyError("ACTION_NOT_ALLOWED", "Action is forbidden by policy");

  if (!["click", "type", "select"].includes(action.type)) return undefined;
  const liveTarget = await liveTargetFor(session, action.elementId);
  const live = liveTarget.live;
  if (live.role !== element.role || live.name !== element.name || live.fingerprint !== element.fingerprint) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ELEMENT_NOT_FOUND", "Observed element changed before action");
  }
  if (!live.visible || !live.inViewport || live.occluded || !live.enabled) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Element is no longer visible and enabled");
  }
  if (live.fileInput && !policy.allowFileUpload) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "File upload is blocked by policy");
  }
  if (action.type === "click" && live.formSubmit && !policy.allowStateMutation) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Form submission is blocked by policy");
  }
  if (action.type === "click" && !policy.allowStateMutation && !live.navigates) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Scriptable control requires allowStateMutation");
  }
  if (action.type === "click" && live.navigates && !policy.allowNavigation) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Navigation is blocked by policy");
  }
  if (action.type === "click" && live.targetUrl && !isAllowedOrigin(live.targetUrl, session.navigationOrigins)) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ORIGIN_BLOCKED", "External-origin navigation is blocked by policy");
  }
  const description = `${live.role} ${live.name} ${live.text} ${live.targetUrl ?? ""} ${action.reasonCode ?? ""}`;
  if (policy.stopBeforeConfirmation && DESTRUCTIVE_PATTERN.test(description)) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Destructive confirmation/payment action blocked");
  }
  if (policy.forbiddenActions.some((name) => FORBIDDEN_ACTION_PATTERNS[name]?.test(description))) {
    await liveTarget.handle.dispose().catch(() => undefined);
    throw policyError("ACTION_NOT_ALLOWED", "Action is forbidden by policy");
  }
  return liveTarget;
}

async function liveTargetFor(session, elementId) {
  const retained = session.handles.get(elementId);
  if (!retained) throw policyError("ELEMENT_NOT_FOUND", "Observed element handle is unavailable");
  const handle = retained.handle;
  let live;
  try {
    live = await handle.evaluate((element) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const inputRole = (input) => {
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "search", "slider"].includes(type)) return type === "submit" ? "button" : type;
      return "textbox";
    };
    const role = element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: inputRole(element), TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" }[element.tagName] ?? "generic");
    const name = normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.getAttribute("alt") || element.getAttribute("name"));
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visible = element.isConnected && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01;
    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    const occluded = visible && inViewport && top !== element && !element.contains(top);
    const type = (element.getAttribute("type") || "").toLowerCase();
    const form = element.form;
    const formSubmit = Boolean(form && ((element.tagName === "BUTTON" && (!type || type === "submit")) || (element.tagName === "INPUT" && ["submit", "image"].includes(type))));
    const targetUrl = element.tagName === "A" && element.href ? element.href : formSubmit ? form.action : undefined;
    return {
      role,
      name,
      text: normalize(element.innerText || element.textContent).slice(0, 500),
      fingerprint: [role, name, element.id || "", element.getAttribute("data-testid") || element.getAttribute("data-test") || "", location.pathname, Math.round(rect.top), Math.round(rect.left)].join("|"),
      enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
      visible,
      inViewport,
      occluded,
      fileInput: element.tagName === "INPUT" && type === "file",
      formSubmit,
      navigates: Boolean((element.tagName === "A" && element.href) || formSubmit),
      targetUrl,
    };
    });
  } catch {
    throw policyError("ELEMENT_NOT_FOUND", "Observed element is no longer available");
  }
  return { handle, live };
}

async function clearHandles(session) {
  await Promise.all([...session.handles.values()].map((item) => item.handle?.dispose?.().catch(() => undefined)));
  session.handles.clear();
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

function normalizeEvidencePolicy(policy = {}) {
  return {
    screenshot: ["off", "on_failure", "every_action"].includes(policy.screenshot) ? policy.screenshot : "every_action",
    trace: policy.trace !== false,
    video: ["off", "on_failure", "all"].includes(policy.video) ? policy.video : "off",
    semanticSnapshot: ["off", "on_failure", "every_action"].includes(policy.semanticSnapshot) ? policy.semanticSnapshot : "every_action",
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
  return httpUrl(new URL(startPath, baseUrl).toString(), "environment.startPath");
}

function normalizeOrigins(origins) {
  return origins.map((origin, index) => new URL(httpUrl(origin, `environment.allowedOrigins[${index}]`)).origin);
}

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} must be a valid HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError(`${name} must be a valid HTTP(S) URL`);
  if (["169.254.169.254", "100.100.100.200"].includes(url.hostname)) throw new TypeError(`${name} targets a blocked metadata host`);
  const operatorHosts = process.env.PERSONA_RUNTIME_ALLOWED_HOSTS?.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (operatorHosts?.length && !operatorHosts.includes(url.hostname.toLowerCase())) throw new TypeError(`${name} is outside PERSONA_RUNTIME_ALLOWED_HOSTS`);
  return url.toString();
}

async function resolveStorageStatePath(value) {
  const root = await realpath(process.cwd());
  const resolved = await realpath(path.resolve(root, requiredString(value, "environment.storageStatePath")));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw policyError("ACTION_NOT_ALLOWED", "storageStatePath must resolve within the workspace");
  }
  const details = await stat(resolved);
  if (!details.isFile() || (details.mode & 0o077) !== 0) throw policyError("ACTION_NOT_ALLOWED", "storageStatePath must be private");
  return resolved;
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

function safeUrl(value, secretValues = []) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    try {
      let pathname = url.pathname;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const decodedPathname = decodeURIComponent(pathname);
        if (decodedPathname === pathname) {
          const redactedPathname = redactRawSecrets(pathname, secretValues);
          if (redactedPathname !== pathname) url.pathname = redactedPathname;
          return redactRawSecrets(url.toString(), secretValues);
        }
        pathname = decodedPathname;
      }
      throw new URIError("pathname decode limit exceeded");
    } catch {
      if (secretValues.length > 0) url.pathname = "/[REDACTED]";
      return url.toString();
    }
  } catch {
    return "invalid-url";
  }
}

function issue(kind, code, message, metadata, now, secretValues = []) {
  const cleanMetadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === "string" ? redactSecrets(value, secretValues) : value]));
  const cleanMessage = redactSecrets(message, secretValues);
  return Object.freeze({
    id: `issue-${hash({ kind, code, message: cleanMessage, metadata: cleanMetadata }).slice(0, 12)}`,
    type: kind === "browser" ? "popup" : kind,
    severity: code,
    message: cleanMessage,
    ...(cleanMetadata.url ? { url: cleanMetadata.url } : {}),
    ...(cleanMetadata.method ? { method: cleanMetadata.method } : {}),
    ...(cleanMetadata.status === undefined ? {} : { status: cleanMetadata.status }),
    ...(cleanMetadata.filename ? { filename: cleanMetadata.filename } : {}),
    ...(cleanMetadata.mimeType ? { mimeType: cleanMetadata.mimeType } : {}),
    timestamp: now(),
  });
}

function redactSecrets(value, secretValues) {
  return redactEncodedSecrets(redactRawSecrets(value, secretValues), secretValues);
}

function redactRawSecrets(value, secretValues) {
  return secretValues.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), String(value));
}

function redactEncodedSecrets(value, secretValues) {
  return secretValues.reduce((redacted, secret) => {
    try {
      const encoded = encodeURIComponent(secret);
      return [encoded, encoded.toLowerCase()].reduce((text, candidate) => text.split(candidate).join("[REDACTED]"), redacted);
    } catch {
      return redacted;
    }
  }, String(value));
}

function redactDeep(value, secretValues) {
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secretValues));
  if (!value || typeof value !== "object") return typeof value === "string" ? redactSecrets(value, secretValues) : value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDeep(child, secretValues)]));
}

async function captureFailureScreenshot(session, observationId) {
  const id = `${observationId}:failure:${++session.screenshotSequence}`;
  const screenshotPath = path.join(session.screenshotDir, `failure-${session.screenshotSequence}.png`);
  try {
    await captureScreenshot(session, screenshotPath, { settleImages: session.evidencePolicy.screenshot === "on_failure" });
    return [await fileEvidence(id, "screenshot", screenshotPath, session.evidenceDir)];
  } catch {
    return [];
  }
}

async function captureScreenshot(session, screenshotPath, { settleImages = false } = {}) {
  if (settleImages) await settleVisibleImages(session.page, session.stabilization);
  await session.page.screenshot({ path: screenshotPath, fullPage: false, mask: [session.page.locator("input,textarea,[contenteditable='true']")] });
}

async function settleVisibleImages(page, policy) {
  await page.waitForFunction(({ quietMs }) => new Promise((resolve) => {
    let previous = "";
    let stableSince = performance.now();
    const sample = () => {
      const images = [...document.images].filter((image) => {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.right > 0
          && rect.top < innerHeight
          && rect.left < innerWidth
          && style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0.01;
      });
      const snapshot = JSON.stringify(images.map((image) => [
        image.currentSrc,
        image.getAttribute("src"),
        image.getAttribute("srcset"),
        image.complete,
      ]));
      const now = performance.now();
      const complete = images.every((image) => image.complete);
      if (snapshot !== previous || !complete) {
        previous = snapshot;
        stableSince = now;
      }
      if (complete && now - stableSince >= quietMs) return resolve(true);
      setTimeout(sample, Math.min(50, Math.max(1, quietMs)));
    };
    sample();
  }), { quietMs: policy.domQuietMs }, { timeout: policy.maxWaitMs }).catch(() => undefined);
}

async function fileEvidence(id, type, absolutePath, evidenceDir) {
  const content = await readFile(absolutePath);
  const details = await stat(absolutePath);
  return Object.freeze({
    id,
    type,
    relativePath: path.relative(evidenceDir, absolutePath),
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    byteSize: details.size,
    metadata: {},
  });
}

function runtimeIssueEvidence(runtimeIssue) {
  const type = runtimeIssue.type === "network"
    ? "network_failure"
    : runtimeIssue.type === "download"
      ? "download"
      : "console_issue";
  return Object.freeze({
    id: `evidence-${runtimeIssue.id}`,
    type,
    contentHash: `sha256:${hash(runtimeIssue)}`,
    metadata: structuredClone(runtimeIssue),
  });
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
