/**
 * Pre-authenticated QA browser session.
 *
 * The operator logs in once (`login` command, headed browser) into a private
 * persistent profile. `judge` relaunches that profile headless with a CDP
 * endpoint and hands `BROWSER_CDP_URL` to Hermes, so the agent browses an
 * already-authenticated browser and credentials never enter the prompt,
 * model context, or artifacts.
 *
 * The runner owns the context; the agent only gets a CDP URL. Everything the
 * runner captures from that context (trace, HAR, video, screenshots, aria
 * snapshots, blocked requests) is evidence the agent cannot forge or omit —
 * a different trust tier from the agent's own narrative.
 */
import {
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { EnvironmentError, UsageError } from "./errors.mjs";
import { captureSettledEvidence } from "./qa-evidence.mjs";

export const SESSION_PROFILE_DIR = join(".private", "qa-browser-profile");

/**
 * Written by `runOperatorLogin` only after the profile actually gained session
 * state. Chromium creates the profile directory (and an empty cookie DB) the
 * moment the window opens, so directory existence proves nothing.
 */
export const SESSION_MARKER_FILE = ".qa-session";

export function sessionProfilePath(root = process.cwd()) {
  return resolve(root, SESSION_PROFILE_DIR);
}

export function sessionMarkerPath(root = process.cwd()) {
  return join(sessionProfilePath(root), SESSION_MARKER_FILE);
}

/**
 * True only when a login actually stored session state. An aborted login
 * (operator closes the window without signing in) leaves a populated-looking
 * profile directory, and treating that as authenticated makes every later
 * judge run browse staging logged out while believing it is signed in.
 */
export function hasSessionProfile(root = process.cwd()) {
  return existsSync(sessionMarkerPath(root));
}

/** Written only once a session actually exists; `hasSessionProfile` reads it. */
export function writeSessionMarker(root = process.cwd(), { cookieCount = 0 } = {}) {
  writeFileSync(
    sessionMarkerPath(root),
    `${JSON.stringify({ savedAt: new Date().toISOString(), cookieCount })}\n`,
    { mode: 0o600 }
  );
}

export function ensurePrivateProfileDir(root = process.cwd()) {
  const path = sessionProfilePath(root);
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(resolve(root, ".private"), 0o700);
    chmodSync(path, 0o700);
  } catch (cause) {
    throw new EnvironmentError(
      `Cannot create the owner-only QA browser profile at ${SESSION_PROFILE_DIR}: ${cause.message}`,
      { hint: `Check ownership and permissions of ${resolve(root, ".private")}.`, cause }
    );
  }
  return path;
}

export function assertPrivateProfileDir(root = process.cwd()) {
  const path = sessionProfilePath(root);
  let stat;
  try {
    stat = statSync(path);
  } catch (cause) {
    throw new EnvironmentError(
      `No QA browser profile at ${SESSION_PROFILE_DIR}.`,
      { hint: "Run: npx playwright-spec-for-ai-agent login", cause }
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new EnvironmentError(
      "QA browser profile must be owner-only.",
      { hint: `Run: chmod -R go-rwx ${SESSION_PROFILE_DIR}` }
    );
  }
  return path;
}

export async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export async function importChromium() {
  try {
    const mod = await import("@playwright/test");
    return mod.chromium;
  } catch (cause) {
    throw new EnvironmentError(
      [
        "The pre-authenticated session flow needs the optional peer dependency @playwright/test.",
        "Install it (npm i -D @playwright/test && npx playwright install chromium)",
        "or pass --credentials-in-prompt to use the legacy prompt-credential flow.",
      ].join("\n"),
      { cause }
    );
  }
}

function describe(error) {
  return error?.message ?? String(error);
}

function normalizeOrigins(origins) {
  return new Set(
    origins.map(origin => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin;
      }
    })
  );
}

function isMainFrameNavigation(request) {
  try {
    return request.isNavigationRequest() && !request.frame().parentFrame();
  } catch {
    return false;
  }
}

/**
 * Origin pinning and mutation blocking at the browser layer. A prompt-injected
 * page can talk an agent into navigating anywhere; it cannot talk its way past
 * an aborted request.
 *
 * ponytail: interception is serviced by this process's event loop, and the
 * hermes adapter runs the agent with spawnSync — while it blocks, no route
 * handler runs and intercepted requests stall until the agent exits. Only
 * enable these guards with an adapter that leaves the loop free; the passive
 * evidence (trace/HAR/video) needs no handler and is unaffected.
 */
async function installRequestGuards(
  context,
  { allowedOrigins, blockMutations, violations }
) {
  const allowed = normalizeOrigins(allowedOrigins);
  await context.route("**/*", async route => {
    const request = route.request();
    try {
      const url = request.url();
      if (
        allowed.size > 0 &&
        isMainFrameNavigation(request) &&
        !allowed.has(new URL(url).origin)
      ) {
        violations.push({ kind: "off-origin-navigation", detail: url });
        await route.abort("blockedbyclient");
        return;
      }
      // A read-only run has no business writing anywhere — including
      // analytics endpoints off the staging origin.
      const method = request.method();
      if (blockMutations && method !== "GET" && method !== "HEAD") {
        violations.push({
          kind: "blocked-mutation",
          detail: `${method} ${new URL(url).pathname}`,
        });
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch (error) {
      violations.push({ kind: "route-error", detail: describe(error) });
      await route.continue().catch(() => {});
    }
  });
}

function firstVideo(context) {
  try {
    for (const page of context.pages()) {
      const video = page.video?.();
      if (video) return video;
    }
  } catch {
    // A closing context has no pages; no video handle is the same as no video.
  }
  return null;
}

/**
 * Relaunch the operator-authenticated profile headless with a CDP endpoint.
 * Returns `{ cdpUrl, capture, close, evidence }`; keep it open for the whole
 * agent run. `close()` resolves to the evidence summary.
 *
 * `evidenceDir` turns on the runner-owned capture set: a Playwright trace,
 * a HAR of every request, and a settled screenshot + aria snapshot per open
 * page taken just before teardown. `recordVideoDir` saves the session as webm,
 * renamed from Playwright's random filename to `<label>.webm` so the file maps
 * back to the run that produced it.
 *
 * ponytail: capture is exposed as `capture(label)` rather than driven on an
 * interval, because the hermes adapter runs the agent with spawnSync — a timer
 * cannot fire while the event loop is blocked, so an interval would silently
 * capture nothing. `close()` calls it once for the settled end state, and an
 * async adapter can call it between steps.
 */
export async function launchAuthenticatedBrowser({
  root = process.cwd(),
  recordVideoDir = null,
  evidenceDir = null,
  allowedOrigins = [],
  blockMutations = false,
  label = "session",
  chromiumFactory = importChromium,
} = {}) {
  const profileDir = assertPrivateProfileDir(root);
  const chromium = await chromiumFactory();
  const port = await findFreePort();
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  if (recordVideoDir) mkdirSync(recordVideoDir, { recursive: true });

  const evidence = {
    tracePath: null,
    harPath: evidenceDir ? join(evidenceDir, `${label}.har`) : null,
    videoPath: null,
    screenshots: [],
    ariaSnapshots: [],
    violations: [],
  };

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    // The CDP endpoint is loopback-only but UNAUTHENTICATED for as long as the
    // agent runs: any process running as this user can attach and drive the
    // authenticated session. Chromium and Playwright offer no authentication
    // for CDP, so the only mitigations are the loopback bind and keeping the
    // window short — close() ends the browser process and with it the port.
    args: [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir } } : {}),
    ...(evidence.harPath ? { recordHar: { path: evidence.harPath } } : {}),
  });

  if (allowedOrigins.length > 0 || blockMutations) {
    await installRequestGuards(context, {
      allowedOrigins,
      blockMutations,
      violations: evidence.violations,
    });
  }

  if (evidenceDir) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      evidence.tracePath = join(evidenceDir, `${label}-trace.zip`);
    } catch (error) {
      evidence.violations.push({
        kind: "capture-failed",
        detail: `tracing.start: ${describe(error)}`,
      });
    }
  }

  async function capture(captureLabel = "capture") {
    if (!evidenceDir) return { screenshots: [], ariaSnapshots: [], violations: [] };
    const captured = await captureSettledEvidence(
      context,
      evidenceDir,
      captureLabel
    );
    evidence.screenshots.push(...captured.screenshots);
    evidence.ariaSnapshots.push(...captured.ariaSnapshots);
    evidence.violations.push(...captured.violations);
    return captured;
  }

  let closed = false;
  async function close() {
    if (closed) return evidence;
    closed = true;
    await capture(`${label}-final`);
    if (evidence.tracePath) {
      try {
        await context.tracing.stop({ path: evidence.tracePath });
      } catch (error) {
        evidence.violations.push({
          kind: "capture-failed",
          detail: `tracing.stop: ${describe(error)}`,
        });
        evidence.tracePath = null;
      }
    }
    const video = recordVideoDir ? firstVideo(context) : null;
    try {
      await context.close();
    } catch (error) {
      // Throwing here would mask whatever the caller was already reporting.
      evidence.violations.push({
        kind: "session-close-failed",
        detail: describe(error),
      });
    }
    if (video) {
      try {
        const produced = await video.path();
        const target = join(recordVideoDir, `${label}.webm`);
        if (produced !== target) renameSync(produced, target);
        evidence.videoPath = target;
      } catch (error) {
        evidence.violations.push({
          kind: "capture-failed",
          detail: `video: ${describe(error)}`,
        });
      }
    }
    return evidence;
  }

  return { cdpUrl: `http://127.0.0.1:${port}`, capture, close, evidence };
}

/**
 * Attach to a browser the operator already runs and already signed into.
 *
 * The headed `login` command covers password and SSO flows, but an identity
 * provider that refuses automation-controlled browsers (Google is the common
 * one) cannot be signed into there at all. Letting the operator use their own
 * Chrome — started once with `--remote-debugging-port` — sidesteps that
 * entirely: they log in as a human, we only borrow the session.
 *
 * Evidence is thinner than a runner-launched context: tracing and per-page
 * capture work, HAR does not, because `recordHar` is a launch-time option and
 * this context already exists. `close()` disconnects; it never closes the
 * operator's browser.
 */
export async function connectExistingBrowser({
  cdpUrl,
  evidenceDir = null,
  label = "session",
  chromiumFactory = importChromium,
} = {}) {
  if (!cdpUrl) {
    throw new UsageError("connectExistingBrowser needs a cdpUrl.", {
      hint: "Pass --cdp-url=http://127.0.0.1:9222 or set QA_BROWSER_CDP_URL.",
    });
  }
  const chromium = await chromiumFactory();
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

  const evidence = {
    tracePath: null,
    harPath: null,
    videoPath: null,
    screenshots: [],
    ariaSnapshots: [],
    violations: [],
  };

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (cause) {
    throw new EnvironmentError(
      `Could not attach to a browser at ${cdpUrl}: ${describe(cause)}`,
      {
        hint: [
          "Start Chrome with a dedicated profile and remote debugging, sign in there, then re-run:",
          '  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\',
          "    --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome",
        ].join("\n"),
        cause,
      }
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());

  if (evidenceDir) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      evidence.tracePath = join(evidenceDir, `${label}-trace.zip`);
    } catch (error) {
      evidence.violations.push({
        kind: "capture-failed",
        detail: `tracing.start: ${describe(error)}`,
      });
    }
    evidence.violations.push({
      kind: "capture-unavailable",
      detail: "HAR is not recorded for an attached browser (launch-time option).",
    });
  }

  async function capture(captureLabel = "capture") {
    if (!evidenceDir) return { screenshots: [], ariaSnapshots: [], violations: [] };
    const captured = await captureSettledEvidence(
      context,
      evidenceDir,
      captureLabel
    );
    evidence.screenshots.push(...captured.screenshots);
    evidence.ariaSnapshots.push(...captured.ariaSnapshots);
    evidence.violations.push(...captured.violations);
    return captured;
  }

  let closed = false;
  async function close() {
    if (closed) return evidence;
    closed = true;
    await capture(`${label}-final`);
    if (evidence.tracePath) {
      try {
        await context.tracing.stop({ path: evidence.tracePath });
      } catch (error) {
        evidence.violations.push({
          kind: "capture-failed",
          detail: `tracing.stop: ${describe(error)}`,
        });
        evidence.tracePath = null;
      }
    }
    try {
      // Disconnects the client. The operator's browser keeps running — we did
      // not launch it, so it is not ours to close.
      await browser.close();
    } catch (error) {
      evidence.violations.push({
        kind: "session-close-failed",
        detail: describe(error),
      });
    }
    return evidence;
  }

  return { cdpUrl, capture, close, evidence, attached: true };
}

async function readCookies(context) {
  try {
    return await context.cookies();
  } catch {
    // The operator closed the window; the last successful poll stands.
    return null;
  }
}

function cookieFingerprint(cookies) {
  return new Set(cookies.map(c => `${c.domain}|${c.name}=${c.value}`));
}

/**
 * Headed login for the operator: opens the login URL in the persistent
 * profile and resolves when the operator closes the browser window.
 * No selectors, no stored credentials — SSO/CAPTCHA flows work unchanged.
 *
 * The session marker is written only when the cookie jar actually changed
 * between the freshly loaded login page and the moment the window closed.
 *
 * ponytail: cookie-set diff, polled once a second — it cannot tell an
 * authenticated cookie from an anonymous one, but it does catch the case that
 * caused the false positive (window closed without ever logging in). Upgrade
 * path if it proves too weak: have the operator confirm an authenticated
 * selector, or check a configured post-login cookie name.
 *
 * @returns {Promise<{authenticated: boolean, cookieCount: number}>}
 */
export async function runOperatorLogin({
  loginUrl,
  root = process.cwd(),
  pollMs = 1000,
  channel = null,
  chromiumFactory = importChromium,
}) {
  const profileDir = ensurePrivateProfileDir(root);
  const chromium = await chromiumFactory();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    // Real Chrome, not bundled Chromium, when asked: some identity providers
    // (Google above all) refuse to sign in from a browser they do not
    // recognise, and the bundled build is the one they refuse most.
    ...(channel ? { channel } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrl);

  const baseline = cookieFingerprint((await readCookies(context)) ?? []);
  let latest = baseline;
  let open = true;
  const untilClosed = new Promise(resolveClosed =>
    context.once("close", () => {
      open = false;
      resolveClosed();
    })
  );
  while (open) {
    await Promise.race([
      untilClosed,
      new Promise(tick => setTimeout(tick, pollMs)),
    ]);
    const cookies = await readCookies(context);
    if (cookies) latest = cookieFingerprint(cookies);
  }

  const authenticated = [...latest].some(cookie => !baseline.has(cookie));
  if (authenticated) {
    writeSessionMarker(root, { cookieCount: latest.size });
  } else {
    console.warn(
      [
        "No session cookies were stored — the login did not complete.",
        `judge will not treat ${SESSION_PROFILE_DIR} as authenticated; run login again and sign in before closing the window.`,
      ].join("\n")
    );
  }
  return { authenticated, cookieCount: latest.size };
}
