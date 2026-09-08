import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EnvironmentError, UsageError } from "./errors.mjs";
import { redactSensitiveText } from "./agent-output.mjs";
import { createBrowserbaseClient } from "./browserbase-client.mjs";
import { connectExistingBrowser, importChromium } from "./qa-browser-session.mjs";

function flag(argv, name, fallback = "") {
  const matches = argv.filter(arg => arg === name || arg.startsWith(`${name}=`));
  if (matches.length > 1) throw new UsageError(`Duplicate ${name}.`);
  if (!matches.length) return fallback;
  const arg = matches[0];
  const value = arg === name ? argv[argv.indexOf(arg) + 1] : arg.slice(name.length + 1);
  if (!value?.trim() || value.startsWith("--")) throw new UsageError(`${name} needs a value.`);
  return value.trim();
}

export function resolveBrowserProvider(argv = [], env = process.env) {
  const provider = flag(argv, "--browser-provider", env.QA_BROWSER_PROVIDER?.trim() || "local");
  if (!["local", "browserbase"].includes(provider)) {
    throw new UsageError("--browser-provider must be local or browserbase (or set QA_BROWSER_PROVIDER).");
  }
  return provider;
}

export function browserbaseOptions(argv = [], env = process.env) {
  const profile = flag(argv, "--browserbase-profile", env.QA_BROWSERBASE_PROFILE?.trim() || "default");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new UsageError("--browserbase-profile must be 1–64 letters, digits, underscores or hyphens.");
  const timeoutSeconds = Number(flag(argv, "--browserbase-timeout", env.QA_BROWSERBASE_TIMEOUT_SECONDS?.trim() || "600"));
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 21600) {
    throw new UsageError("--browserbase-timeout must be an integer from 60 to 21600 seconds.");
  }
  return { profile, timeoutSeconds, successUrl: flag(argv, "--success-url"), successSelector: flag(argv, "--success-selector") };
}

function safeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new UsageError("Browserbase needs a valid HTTP(S) target URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new UsageError("Browserbase target must be HTTP(S) without embedded credentials.");
  return url.origin;
}

function identityKey({ projectId, origin, profile = "default" }) {
  if (!projectId) throw new EnvironmentError("BROWSERBASE_PROJECT_ID is required.");
  return createHash("sha256").update(JSON.stringify([projectId, safeOrigin(origin), profile])).digest("hex");
}

function privateDir(root, create = false) {
  const dir = join(root, ".private");
  let info;
  try { info = lstatSync(dir); } catch (error) { if (error.code !== "ENOENT") throw new EnvironmentError("Browserbase private directory is inaccessible."); }
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EnvironmentError("Browserbase .private directory must not be a symlink or non-directory.");
    if (create) chmodSync(dir, 0o700);
  } else if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readRegistry(root) {
  const file = join(privateDir(root), "qa-browserbase-contexts.json");
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe file");
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.contexts || typeof data.contexts !== "object" || Array.isArray(data.contexts)) throw new Error("invalid schema");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, contexts: {} };
    throw new EnvironmentError("Browserbase context registry is unreadable, malformed, or a symlink.", { hint: "Inspect .private/qa-browserbase-contexts.json without sharing its contents." });
  }
}

export function readBrowserbaseContext({ root = process.cwd(), ...identity }) {
  const record = readRegistry(root).contexts[identityKey(identity)];
  if (!record) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(record.contextId || "") || record.projectId !== identity.projectId || record.origin !== safeOrigin(identity.origin) || record.profile !== (identity.profile || "default")) {
    throw new EnvironmentError("Browserbase context registry entry is invalid.");
  }
  return record;
}

export function saveBrowserbaseContext({ root = process.cwd(), projectId, origin, profile = "default", contextId, successUrl = "", successSelector = "" }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(contextId || "")) throw new UsageError("Invalid Browserbase context ID.");
  const identity = { projectId, origin: safeOrigin(origin), profile };
  const dir = privateDir(root, true);
  const unlock = acquireLock(join(dir, "qa-browserbase-registry.lock"));
  const temp = join(dir, `qa-browserbase-${randomUUID()}.tmp`);
  try {
    const data = readRegistry(root);
    data.contexts[identityKey(identity)] = { ...identity, contextId, successUrl, successSelector, verifiedAt: new Date().toISOString() };
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, join(dir, "qa-browserbase-contexts.json"));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    unlock();
  }
}

function acquireLock(path) {
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch { throw new EnvironmentError("Browserbase context profile is in use or its lock cannot be created.", { hint: "Use a separate --browserbase-profile for parallel accounts. After a crash, verify no QA process is running before removing its .private/qa-browserbase-*.lock file." }); }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  let released = false;
  return () => { if (!released) { released = true; unlinkSync(path); } };
}

async function release(client, id) {
  try { await client.releaseSession(id); }
  catch {
    // Disconnecting the last CDP client may already have ended the session.
    const session = await client.getSession(id);
    if (!["COMPLETED", "TIMED_OUT", "ERROR"].includes(session.status)) throw new EnvironmentError("Browserbase session release failed. Check its dashboard and release it manually.");
  }
}

function redactProviderSecrets(text, secrets) {
  // Match complete access URLs before the generic redactor rewrites query values.
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
  }
  return redactSensitiveText(text);
}

function scrub(value, secrets) {
  return JSON.parse(redactProviderSecrets(JSON.stringify(value), secrets));
}

async function preflightBrowserbasePeer(connect) {
  if (connect !== connectExistingBrowser) return;
  try { await importChromium(); }
  catch {
    throw new EnvironmentError("Browserbase requires the optional peer dependency @playwright/test.", {
      hint: "Install it with npm i -D @playwright/test. Browserbase runs Chromium remotely, so no local browser download is needed.",
    });
  }
}

/** The provider owns allocation/release, not the AI adapter. No CDP URLs in artifacts. */
export async function launchBrowserbaseSession({
  root = process.cwd(), projectId = process.env.BROWSERBASE_PROJECT_ID?.trim(), origin,
  profile = "default", contextId = null, persist = false, timeoutSeconds = 600,
  evidenceDir = null, label = "session", client = null, connect = connectExistingBrowser,
  holdLockUntilSaved = false, signal = null, profileUnlock = null,
} = {}) {
  signal?.throwIfAborted();
  client ??= createBrowserbaseClient();
  await preflightBrowserbasePeer(connect);
  signal?.throwIfAborted();
  const identity = { projectId, origin, profile };
  const unlock = profileUnlock ?? acquireLock(join(privateDir(root, true), `qa-browserbase-${identityKey(identity)}.lock`));
  let allocated, attached;
  try {
    if (contextId) {
      const context = await client.getContext(contextId);
      signal?.throwIfAborted();
      if (context.projectId && context.projectId !== projectId) throw new EnvironmentError("Browserbase Context belongs to a different project.");
    }
    allocated = await client.createSession({ contextId: contextId ?? undefined, persist, timeout: timeoutSeconds });
    signal?.throwIfAborted();
    attached = await connect({ cdpUrl: allocated.connectUrl, evidenceDir, label });
    signal?.throwIfAborted();
  } catch {
    try { if (attached) await attached.close(); }
    finally {
      try { if (allocated) await release(client, allocated.id); }
      finally { if (!profileUnlock) unlock(); }
    }
    signal?.throwIfAborted();
    throw new EnvironmentError("Browserbase session could not be created or attached.", { hint: "Check API credentials, project, saved Context and remote session availability. Browserbase cannot reach localhost without a tunnel." });
  }
  const secrets = [allocated.connectUrl, process.env.BROWSERBASE_API_KEY].filter(Boolean).sort((a, b) => b.length - a.length);
  const metadata = { name: "browserbase", sessionId: allocated.id, contextId, dashboardUrl: `https://www.browserbase.com/sessions/${encodeURIComponent(allocated.id)}` };
  attached.evidence.browserProvider = metadata;
  attached.evidence.violations.push({ kind: "capture-unavailable", detail: "Browserbase: local HAR/video and local origin/mutation guards are unavailable on this remote attach path. A read-only prompt is not an enforcement boundary." });
  let closePromise;
  const onSignal = signal => { close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); };
  const onInt = () => onSignal("SIGINT"), onTerm = () => onSignal("SIGTERM");
  // Login owns signals until its Context persistence and lock cleanup finish.
  if (!signal) { process.once("SIGINT", onInt); process.once("SIGTERM", onTerm); }
  function close() {
    closePromise ??= (async () => {
      let failed = false;
      try { await attached.close(); } catch { failed = true; }
      try { await release(client, allocated.id); } catch { failed = true; }
      finally {
        process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
        if (!holdLockUntilSaved && !profileUnlock) unlock();
      }
      if (failed) throw new EnvironmentError("Browserbase evidence capture or session release failed.", { hint: `Check session ${allocated.id} in the Browserbase dashboard. The configured remote timeout limits its lifetime.` });
      return scrub(attached.evidence, secrets);
    })();
    return closePromise;
  }
  return { ...attached, cdpUrl: allocated.connectUrl, close, releaseLock: unlock, metadata, secrets, client, evidence: attached.evidence };
}

/** Synchronous adapters inherit one session. Restore every variable even on failure. */
export function withBrowserbaseAgentEnv(session, callback) {
  const overlay = { BROWSER_CDP_URL: session.cdpUrl, PLAYWRIGHT_MCP_CDP_ENDPOINT: session.cdpUrl, BROWSERBASE_API_KEY: undefined };
  const previous = Object.fromEntries(Object.keys(overlay).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overlay)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const result = callback();
    return result === undefined ? result : scrub(result, session.secrets);
  } catch (error) {
    const secrets = [...session.secrets].sort((a, b) => b.length - a.length);
    error.message = redactProviderSecrets(error.message, secrets);
    if (error.stack) error.stack = redactProviderSecrets(error.stack, secrets);
    if (error.hint) error.hint = redactProviderSecrets(error.hint, secrets);
    delete error.cause;
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function successLocation(value, loginUrl) {
  if (!value) return "";
  let url;
  try { url = new URL(value, loginUrl); } catch { throw new UsageError("--success-url must be a valid URL or path."); }
  safeOrigin(url.href);
  if (url.search) throw new UsageError("--success-url must not contain query parameters. Use a stable path or --success-selector.");
  return url.href;
}

/** Live View login needs observable user-supplied success, not just a changed cookie. */
export async function runBrowserbaseLogin({
  root = process.cwd(), projectId = process.env.BROWSERBASE_PROJECT_ID?.trim(),
  loginUrl, profile = "default", timeoutSeconds = 600, successUrl = "", successSelector = "",
  client = null, connect = connectExistingBrowser, sleep: wait = sleep, log = console.log,
} = {}) {
  if (!successUrl && !successSelector) throw new UsageError("Browserbase login requires --success-url or --success-selector to verify completion.");
  const origin = safeOrigin(loginUrl);
  const expected = successLocation(successUrl, loginUrl);
  if (expected && safeOrigin(expected) !== origin) throw new UsageError("--success-url must be on the login site's origin.");
  const loginLocation = new URL(loginUrl); loginLocation.search = "";
  if (expected === loginLocation.href && !successSelector) throw new UsageError("--success-url must differ from the login page, or include --success-selector.");
  client ??= createBrowserbaseClient();
  const identity = { root, projectId, origin, profile };
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = name => controller.abort(new EnvironmentError(`Browserbase login interrupted by ${name}.`, { exitCode: name === "SIGINT" ? 130 : 143 }));
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  // Keep these installed during in-flight allocations and every cleanup await.
  // Never race allocations: their eventual IDs are needed to release resources.
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  let previous, contextId, session, unlock, saved = false;
  try {
    await preflightBrowserbasePeer(connect);
    signal.throwIfAborted();
    // Login owns the lock even when session startup fails before returning a handle.
    unlock = acquireLock(join(privateDir(root, true), `qa-browserbase-${identityKey(identity)}.lock`));
    previous = readBrowserbaseContext(identity);
    contextId = previous?.contextId || (await client.createContext()).id;
    signal.throwIfAborted();
    session = await launchBrowserbaseSession({ ...identity, contextId, persist: true, timeoutSeconds, client, connect, holdLockUntilSaved: true, signal, profileUnlock: unlock });
    signal.throwIfAborted();
    const debug = await client.getDebug(session.metadata.sessionId);
    signal.throwIfAborted();
    const liveUrl = debug.debuggerFullscreenUrl || debug.debuggerUrl;
    if (!liveUrl) throw new EnvironmentError("Browserbase Live View URL unavailable.");
    log(`Browserbase Live View (private access link, do not share): ${liveUrl}`);
    log(`Complete login within ${timeoutSeconds} seconds. Waiting for the configured success condition.`);
    const page = session.context.pages()[0] || await session.context.newPage();
    signal.throwIfAborted();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    signal.throwIfAborted();
    const deadline = Date.now() + timeoutSeconds * 1000;
    let authenticated = false;
    while (Date.now() < deadline && !authenticated) {
      for (const candidate of session.context.pages()) {
        try {
          const current = new URL(candidate.url());
          if (current.origin !== origin) continue;
          current.search = "";
          if (expected && current.href !== expected) continue;
          if (successSelector && !await candidate.locator(successSelector).first().isVisible()) continue;
          authenticated = true; break;
        } catch { /* Redirecting/closed tabs are not proof of login. */ }
      }
      signal.throwIfAborted();
      if (!authenticated) await wait(1000);
      signal.throwIfAborted();
    }
    if (!authenticated) throw new EnvironmentError("Browserbase login timed out before its success condition was observed.");
    await session.close();
    signal.throwIfAborted();
    // REQUEST_RELEASE is asynchronous. Never mark a still-running Context saved.
    let ended = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const remote = await client.getSession(session.metadata.sessionId);
      signal.throwIfAborted();
      if (remote.status === "COMPLETED") { ended = true; break; }
      if (["TIMED_OUT", "ERROR"].includes(remote.status)) break;
      await wait(1000);
      signal.throwIfAborted();
    }
    if (!ended) throw new EnvironmentError("Browserbase login session did not complete cleanly. Context was not marked ready.");
    await wait(3000); // Official Context workflow: allow a few seconds for persistence.
    signal.throwIfAborted();
    await client.getContext(contextId);
    signal.throwIfAborted();
    saveBrowserbaseContext({ ...identity, contextId, successUrl: expected, successSelector });
    saved = true;
    return { authenticated: true, contextId };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof UsageError || error instanceof EnvironmentError) throw error;
    throw new EnvironmentError("Browserbase login failed before its Context could be verified and saved.");
  } finally {
    try { if (session) await session.close(); }
    finally {
      try { if (contextId && !saved && !previous) await client.deleteContext(contextId); }
      finally {
        try { unlock?.(); }
        finally { process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); }
      }
    }
  }
}
