import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserbaseClient } from "../browserbase-client.mjs";
import { EnvironmentError } from "../errors.mjs";
import * as browserSession from "../qa-browser-session.mjs";
import {
  resolveBrowserProvider, browserbaseOptions, readBrowserbaseContext,
  saveBrowserbaseContext, launchBrowserbaseSession, runBrowserbaseLogin,
  withBrowserbaseAgentEnv,
} from "../browser-provider.mjs";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "bb-provider-")); roots.push(r); return r; };
const identity = { projectId: "project-1", origin: "https://app.example.test", profile: "default" };
function client() {
  return {
    createContext: vi.fn(async () => ({ id: "context-1" })),
    getContext: vi.fn(async () => ({ id: "context-1", projectId: "project-1" })),
    createSession: vi.fn(async () => ({ id: "session-1", connectUrl: "wss://connect.browserbase.com?apiKey=TOPSECRET&sessionId=session-1" })),
    getSession: vi.fn(async () => ({ id: "session-1", status: "COMPLETED" })),
    getDebug: vi.fn(async () => ({ debuggerFullscreenUrl: "https://www.browserbase.com/devtools/local-test" })),
    releaseSession: vi.fn(async () => ({ id: "session-1", status: "COMPLETED" })),
    deleteContext: vi.fn(async () => undefined),
  };
}
function connection(page: any = null) {
  const evidence = { screenshots: [], ariaSnapshots: [], violations: [], tracePath: null, harPath: null, videoPath: null };
  const context = { pages: () => page ? [page] : [], newPage: vi.fn(async () => page) };
  return { context, evidence, capture: vi.fn(async () => ({})), close: vi.fn(async () => evidence) };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("provider selection", () => {
  it("defaults local and supports flag precedence and both argv forms", () => {
    expect(resolveBrowserProvider([], {})).toBe("local");
    expect(resolveBrowserProvider([], { QA_BROWSER_PROVIDER: "browserbase" })).toBe("browserbase");
    expect(resolveBrowserProvider(["--browser-provider", "local"], { QA_BROWSER_PROVIDER: "browserbase" })).toBe("local");
    expect(resolveBrowserProvider(["--browser-provider=browserbase"], {})).toBe("browserbase");
  });
  it("rejects unknown or empty provider instead of falling back", () => {
    expect(() => resolveBrowserProvider(["--browser-provider=oops"], {})).toThrow(/browser-provider/);
    expect(() => resolveBrowserProvider(["--browser-provider"], {})).toThrow();
  });
  it("bounds timeout and profile without requiring API credentials", () => {
    expect(browserbaseOptions([], {})).toMatchObject({ profile: "default", timeoutSeconds: 600 });
    expect(browserbaseOptions(["--browserbase-timeout", "120", "--browserbase-profile=admin"], {})).toMatchObject({ profile: "admin", timeoutSeconds: 120 });
    for (const value of ["0", "59", "21601", "NaN", "1.5"]) expect(() => browserbaseOptions([`--browserbase-timeout=${value}`], {})).toThrow();
    expect(() => browserbaseOptions(["--browserbase-profile=../../elsewhere"], {})).toThrow();
  });
});

describe("optional browser peer preflight", () => {
  it.each(["login", "session"])("rejects missing Playwright before paid %s allocation", async mode => {
    const api = client();
    // Keep the red-phase fallback local if preflight regresses and attach is reached.
    api.createSession.mockResolvedValue({ id: "session-1", connectUrl: "ws://127.0.0.1:1" });
    const preflight = vi.spyOn(browserSession, "importChromium").mockRejectedValueOnce(new EnvironmentError("missing @playwright/test", { hint: "Use --credentials-in-prompt or npx playwright install chromium", cause: Error("private cause") }));
    try {
      const options = { root: root(), ...identity, client: api };
      const operation = mode === "login"
        ? runBrowserbaseLogin({ ...options, loginUrl: identity.origin + "/login", successUrl: "/dashboard", log: () => {} })
        : launchBrowserbaseSession(options);
      await expect(operation).rejects.toMatchObject({ message: "Browserbase requires the optional peer dependency @playwright/test.", hint: "Install it with npm i -D @playwright/test. Browserbase runs Chromium remotely, so no local browser download is needed." });
      await expect(operation).rejects.not.toHaveProperty("cause");
      expect(api.createContext).not.toHaveBeenCalled();
      expect(api.createSession).not.toHaveBeenCalled();
      expect(api.getContext).not.toHaveBeenCalled();
    } finally { preflight.mockRestore(); }
  });
  it.each(["login", "session"])("validates credentials before the %s peer preflight", async mode => {
    vi.stubEnv("BROWSERBASE_API_KEY", "");
    const preflight = vi.spyOn(browserSession, "importChromium").mockRejectedValue(new EnvironmentError("missing @playwright/test"));
    try {
      const options = { root: root(), ...identity };
      const operation = mode === "login"
        ? runBrowserbaseLogin({ ...options, loginUrl: identity.origin + "/login", successUrl: "/dashboard" })
        : launchBrowserbaseSession(options);
      await expect(operation).rejects.toThrow(/BROWSERBASE_API_KEY/);
      expect(preflight).not.toHaveBeenCalled();
    } finally { preflight.mockRestore(); }
  });
});

describe("private scoped contexts", () => {
  it("stores only allowlisted metadata and scopes by project, origin, account", () => {
    const r = root();
    saveBrowserbaseContext({ root: r, ...identity, contextId: "context-1", successUrl: "https://app.example.test/dashboard" });
    expect(readBrowserbaseContext({ root: r, ...identity })?.contextId).toBe("context-1");
    expect(readBrowserbaseContext({ root: r, ...identity, profile: "admin" })).toBeNull();
    expect(readBrowserbaseContext({ root: r, ...identity, projectId: "other" })).toBeNull();
    expect(readBrowserbaseContext({ root: r, ...identity, origin: "https://other.test" })).toBeNull();
    expect(statSync(join(r, ".private")).mode & 0o777).toBe(0o700);
    const file = join(r, ".private", "qa-browserbase-contexts.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("apiKey");
  });
  it("rejects malformed state and symlinked private directory", () => {
    const r = root(); mkdirSync(join(r, ".private"), { mode: 0o700 });
    writeFileSync(join(r, ".private", "qa-browserbase-contexts.json"), "bad json", { mode: 0o600 });
    expect(() => readBrowserbaseContext({ root: r, ...identity })).toThrow(/context/i);
    const s = root(); symlinkSync(r, join(s, ".private"));
    expect(() => saveBrowserbaseContext({ root: s, ...identity, contextId: "context-1" })).toThrow(/symlink/i);
  });
});

describe("owned remote session lifecycle", () => {
  it("uses the real client contract for a public session without a Context", async () => {
    const requests: any[] = [];
    const api = createBrowserbaseClient({ apiKey: "test-key", projectId: identity.projectId, fetchImpl: async (_url: string, init: any) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: "session-1", status: "COMPLETED", connectUrl: "wss://connect.browserbase.com?sessionId=session-1" }) };
    } });
    const session = await launchBrowserbaseSession({ root: root(), ...identity, client: api, contextId: null, connect: async () => connection() });
    expect(requests[0].browserSettings?.context).toBeUndefined();
    await session.close();
  });
  it("holds a login profile lock until persistence is saved", async () => {
    const r = root(), api = client();
    const session = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection(), holdLockUntilSaved: true });
    await session.close();
    await expect(launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() })).rejects.toThrow(/in use/i);
    session.releaseLock();
    const next = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() });
    await next.close();
  });
  it("attaches the allocated session, records safe metadata, and releases once", async () => {
    const r = root(), api = client(), attached = connection();
    const connect = vi.fn(async () => attached);
    const session = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect, timeoutSeconds: 120 });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ cdpUrl: expect.stringContaining("TOPSECRET") }));
    expect(session.evidence.browserProvider).toMatchObject({ name: "browserbase", sessionId: "session-1" });
    expect(JSON.stringify(session.evidence)).not.toContain("TOPSECRET");
    await session.close(); await session.close();
    expect(api.releaseSession).toHaveBeenCalledTimes(1);
  });
  it("releases a session when CDP attach fails and suppresses credential-bearing errors", async () => {
    const api = client();
    await expect(launchBrowserbaseSession({ root: root(), ...identity, client: api, connect: async () => { throw Error("wss://host?apiKey=TOPSECRET"); } })).rejects.toThrow(/Browserbase/);
    expect(api.releaseSession).toHaveBeenCalledTimes(1);
  });
  it("releases and unlocks even if evidence capture fails", async () => {
    const r = root(), api = client(), attached = connection();
    attached.close.mockRejectedValueOnce(Error("TOPSECRET"));
    const session = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => attached });
    await expect(session.close()).rejects.toThrow(/Browserbase/);
    expect(api.releaseSession).toHaveBeenCalledTimes(1);
    const next = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() });
    await next.close();
  });
  it("refuses concurrent use of the same context profile before allocating", async () => {
    const r = root(), api = client();
    const session = await launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() });
    await expect(launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() })).rejects.toThrow(/in use/i);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    await session.close();
  });
  it("restores CDP environment and redacts provider secrets from callback errors", () => {
    vi.stubEnv("BROWSER_CDP_URL", "old"); vi.stubEnv("PLAYWRIGHT_MCP_CDP_ENDPOINT", "old-alias");
    vi.stubEnv("BROWSERBASE_API_KEY", "TOPSECRET");
    const s = { cdpUrl: "wss://host?apiKey=TOPSECRET", secrets: ["TOPSECRET", "wss://host?apiKey=TOPSECRET"] };
    expect(() => withBrowserbaseAgentEnv(s, () => {
      expect(process.env.BROWSER_CDP_URL).toBe(s.cdpUrl);
      expect(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe(s.cdpUrl);
      expect(process.env.BROWSERBASE_API_KEY).toBeUndefined();
      throw Error("TOPSECRET");
    })).toThrow("[redacted]");
    expect(process.env.BROWSER_CDP_URL).toBe("old");
    expect(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe("old-alias");
    expect(process.env.BROWSERBASE_API_KEY).toBe("TOPSECRET");
  });
  it("redacts the error hint printed by the public CLI", () => {
    const session = { cdpUrl: "wss://host?apiKey=TOPSECRET", secrets: ["TOPSECRET", "wss://host?apiKey=TOPSECRET"] };
    let caught: any;
    try { withBrowserbaseAgentEnv(session, () => { throw new EnvironmentError("failed", { hint: `retry ${session.cdpUrl}` }); }); } catch (error) { caught = error; }
    expect(caught.hint).toBe("retry [redacted]");
  });
});

describe("operator login", () => {
  it.each(["SIGINT", "SIGTERM"].flatMap(signal => ["context allocation", "context validation", "session allocation", "attach", "login polling", "release", "completion polling", "persistence", "context verification"].map(stage => [signal, stage])))("cancels %s safely during %s", async (signal, stage) => {
    const r = root(), api = client();
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
    let signalled = false;
    const interrupt = () => {
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM.length + 1);
      signalled = true;
      process.emit(signal as "SIGINT" | "SIGTERM");
      process.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    };
    const page = { url: () => identity.origin + (stage === "login polling" && !signalled ? "/login" : "/dashboard"), goto: vi.fn(async () => undefined) };
    const attached = connection(page);
    if (stage === "context allocation") api.createContext.mockImplementationOnce(async () => { interrupt(); return { id: "context-1" }; });
    if (stage === "context validation") api.getContext.mockImplementationOnce(async () => { interrupt(); return { id: "context-1", projectId: "project-1" }; });
    if (stage === "session allocation") api.createSession.mockImplementationOnce(async () => { interrupt(); return { id: "session-1", connectUrl: "wss://host?apiKey=TOPSECRET" }; });
    if (stage === "release") api.releaseSession.mockImplementationOnce(async () => { interrupt(); return { id: "session-1", status: "COMPLETED" }; });
    if (stage === "completion polling") api.getSession.mockImplementationOnce(async () => { interrupt(); return { id: "session-1", status: "COMPLETED" }; });
    if (stage === "context verification") api.getContext.mockImplementationOnce(async () => ({ id: "context-1", projectId: "project-1" })).mockImplementationOnce(async () => { interrupt(); return { id: "context-1", projectId: "project-1" }; });
    try {
      await expect(runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api,
        connect: async () => { if (stage === "attach") interrupt(); return attached; },
        sleep: async ms => { if (!signalled && (stage === "login polling" || stage === "persistence" && ms === 3000)) interrupt(); }, log: () => {},
      })).rejects.toMatchObject({ message: expect.stringMatching(/interrupt|cancel/i), exitCode: signal === "SIGINT" ? 130 : 143 });
      expect(signalled).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      expect(api.deleteContext).toHaveBeenCalledExactlyOnceWith("context-1");
      if (api.createSession.mock.calls.length) expect(api.releaseSession).toHaveBeenCalledTimes(1);
      if (!["context allocation", "context validation", "session allocation"].includes(stage)) expect(attached.close).toHaveBeenCalledTimes(1);
      expect(readBrowserbaseContext({ root: r, ...identity })).toBeNull();
      if (existsSync(join(r, ".private"))) expect(readdirSync(join(r, ".private")).filter(name => name.endsWith(".lock"))).toEqual([]);
      expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
      expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
    } finally {
      exit.mockRestore();
      for (const signal of ["SIGINT", "SIGTERM"] as const) for (const handler of process.listeners(signal)) if (!before[signal].includes(handler)) process.removeListener(signal, handler);
    }
  });
  it("waits for an in-flight allocation ID before releasing and deleting", async () => {
    const r = root(), api = client();
    let resolveAllocation!: (value: any) => void, allocationStarted!: () => void;
    const started = new Promise<void>(resolve => { allocationStarted = resolve; });
    api.createSession.mockImplementationOnce(() => { allocationStarted(); return new Promise(resolve => { resolveAllocation = resolve; }); });
    const connect = vi.fn(async () => connection());
    const login = runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect, log: () => {} });
    const rejection = expect(login).rejects.toMatchObject({ exitCode: 143 });
    await started;
    process.emit("SIGTERM");
    await Promise.resolve();
    expect(api.releaseSession).not.toHaveBeenCalled();
    expect(api.deleteContext).not.toHaveBeenCalled();
    expect(readdirSync(join(r, ".private")).some(name => name.endsWith(".lock"))).toBe(true);
    resolveAllocation({ id: "session-1", connectUrl: "wss://host" });
    await rejection;
    expect(connect).not.toHaveBeenCalled();
    expect(api.releaseSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(api.deleteContext).toHaveBeenCalledExactlyOnceWith("context-1");
    expect(readdirSync(join(r, ".private"))).toEqual([]);
  });
  it("retains the login profile lock during Context deletion after attach failure", async () => {
    const r = root(), api = client();
    let finishDelete!: () => void, deletionStarted!: () => void;
    const started = new Promise<void>(resolve => { deletionStarted = resolve; });
    api.deleteContext.mockImplementationOnce(() => { deletionStarted(); return new Promise<void>(resolve => { finishDelete = resolve; }); });
    const login = runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect: async () => { throw Error("attach failed"); }, log: () => {} });
    const rejection = expect(login).rejects.toThrow(/Browserbase/);
    await started;
    let competing: any;
    try {
      await expect(launchBrowserbaseSession({ root: r, ...identity, client: api, connect: async () => connection() }).then(session => { competing = session; return session; })).rejects.toThrow(/in use/);
      expect(api.createSession).toHaveBeenCalledTimes(1);
    } finally {
      await competing?.close();
      finishDelete();
      await rejection;
    }
    expect(readdirSync(join(r, ".private"))).toEqual([]);
  });
  it("keeps handlers through failing final cleanup and still unlocks", async () => {
    const r = root(), api = client();
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const page = { goto: vi.fn(async () => { throw Error("navigation failed"); }) };
    api.deleteContext.mockImplementationOnce(async () => {
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM.length + 1);
      process.emit("SIGINT"); process.emit("SIGTERM");
      throw new EnvironmentError("delete failed");
    });
    await expect(runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect: async () => connection(page), log: () => {} })).rejects.toThrow("delete failed");
    expect(api.releaseSession).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(r, ".private"))).toEqual([]);
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
  });
  it("preserves a previously saved Context when interrupted", async () => {
    const r = root(), api = client();
    saveBrowserbaseContext({ root: r, ...identity, contextId: "context-1" });
    const registry = readFileSync(join(r, ".private", "qa-browserbase-contexts.json"), "utf8");
    api.getContext.mockImplementationOnce(async () => { process.emit("SIGINT"); return { id: "context-1", projectId: "project-1" }; });
    await expect(runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, log: () => {} })).rejects.toMatchObject({ exitCode: 130 });
    expect(api.createContext).not.toHaveBeenCalled();
    expect(api.deleteContext).not.toHaveBeenCalled();
    expect(readFileSync(join(r, ".private", "qa-browserbase-contexts.json"), "utf8")).toBe(registry);
    expect(readdirSync(join(r, ".private")).filter(name => name.endsWith(".lock"))).toEqual([]);
  });
  it("rejects a success URL equivalent to the login page after query stripping", async () => {
    await expect(runBrowserbaseLogin({ root: root(), ...identity, loginUrl: identity.origin + "/login?next=dashboard", successUrl: "/login", client: client(), connect: async () => { throw Error("must not connect"); } })).rejects.toThrow(/differ/);
  });
  it("does not mark a remotely timed-out session as a reusable login", async () => {
    const r = root(), api = client();
    api.getSession.mockResolvedValue({ id: "session-1", status: "TIMED_OUT" });
    const page = { url: () => identity.origin + "/dashboard", goto: vi.fn(async () => undefined) };
    await expect(runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect: async () => connection(page), sleep: async () => {}, log: () => {} })).rejects.toThrow(/complete cleanly/);
    expect(readBrowserbaseContext({ root: r, ...identity })).toBeNull();
  });
  it("requires an explicit success condition before any paid API call", async () => {
    const api = client();
    await expect(runBrowserbaseLogin({ root: root(), ...identity, loginUrl: identity.origin + "/login", client: api })).rejects.toThrow(/success-url|success-selector/);
    expect(api.createContext).not.toHaveBeenCalled();
  });
  it("saves a context only after verified navigation and session release", async () => {
    const r = root(), api = client();
    const page = { url: () => identity.origin + "/dashboard", goto: vi.fn(async () => undefined), locator: () => ({ isVisible: async () => true }) };
    const attached = connection(page);
    const result = await runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect: async () => attached, sleep: async () => {}, log: () => {} });
    expect(result.authenticated).toBe(true);
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ contextId: "context-1", persist: true }));
    expect(readBrowserbaseContext({ root: r, ...identity })?.contextId).toBe("context-1");
    expect(api.releaseSession).toHaveBeenCalled();
  });
  it("does not store state and deletes a new context if navigation fails", async () => {
    const r = root(), api = client();
    const page = { goto: vi.fn(async () => { throw Error("secret-login-url"); }) };
    await expect(runBrowserbaseLogin({ root: r, ...identity, loginUrl: identity.origin + "/login", successUrl: "/dashboard", client: api, connect: async () => connection(page), sleep: async () => {}, log: () => {} })).rejects.toThrow(/Browserbase/);
    expect(readBrowserbaseContext({ root: r, ...identity })).toBeNull();
    expect(api.releaseSession).toHaveBeenCalled();
    expect(api.deleteContext).toHaveBeenCalledWith("context-1");
  });
});
