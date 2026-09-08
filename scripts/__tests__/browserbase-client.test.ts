import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserbaseClient } from "../browserbase-client.mjs";
import { EnvironmentError, formatQaError } from "../errors.mjs";

const secret = "DO_NOT_LEAK_API_SECRET";
const connectUrl = `wss://connect.browserbase.com?apiKey=${secret}`;
const session = { id: "session-1", status: "RUNNING", connectUrl };
const debug = {
  debuggerUrl: "https://www.browserbase.com/devtools?token=private",
  debuggerFullscreenUrl: "https://www.browserbase.com/devtools/full?token=private",
  wsUrl: connectUrl,
  pages: [{ id: "page-1", debuggerUrl: "https://www.browserbase.com/page", debuggerFullscreenUrl: "https://www.browserbase.com/page/full", title: secret, url: `https://example.com?secret=${secret}` }],
};
function setup(data: unknown = session, status = 200) {
  const fetchImpl = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(data), { status }));
  return { fetchImpl, client: createBrowserbaseClient({ apiKey: secret, projectId: "project-1", fetchImpl }) };
}
async function sanitized(promise: Promise<unknown>) {
  const error = await promise.catch((error) => error);
  expect(error).toBeInstanceOf(EnvironmentError);
  expect(error.cause).toBeUndefined();
  expect(`${formatQaError(error)} ${error.stack} ${JSON.stringify(error)}`).not.toContain(secret);
  return error;
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Browserbase REST client", () => {
  it("uses environment defaults and the global fetch without exposing credentials", async () => {
    vi.stubEnv("BROWSERBASE_API_KEY", secret);
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project-1");
    const fetchImpl = vi.fn(async () => new Response('{"id":"context-1"}', { status: 201 }));
    vi.stubGlobal("fetch", fetchImpl);
    expect(await createBrowserbaseClient().createContext()).toEqual({ id: "context-1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.browserbase.com/v1/contexts", expect.objectContaining({
      method: "POST", body: '{"projectId":"project-1"}', redirect: "error",
      headers: { "X-BB-API-Key": secret, "Content-Type": "application/json" }, signal: expect.any(AbortSignal),
    }));
  });
  it.each(["apiKey", "projectId"])("requires %s", (field) => {
    expect(() => createBrowserbaseClient({ apiKey: secret, projectId: "project-1", [field]: " " })).toThrow(EnvironmentError);
  });
  it("creates sessions with optional persistent contexts", async () => {
    const { client, fetchImpl } = setup();
    expect(await client.createSession({ contextId: "context-1", persist: true, timeout: 900 })).toEqual(session);
    expect(fetchImpl).toHaveBeenLastCalledWith("https://api.browserbase.com/v1/sessions", expect.objectContaining({ method: "POST", body: JSON.stringify({ projectId: "project-1", timeout: 900, browserSettings: { context: { id: "context-1", persist: true } } }) }));
    await client.createSession({ contextId: "context-1" });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)![1].body)).toEqual({ projectId: "project-1", timeout: 600, browserSettings: { context: { id: "context-1", persist: false } } });
    await client.createSession();
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)![1].body)).toEqual({ projectId: "project-1", timeout: 600 });
  });
  it.each([
    ["getContext", "/contexts/context-1", "context-1", { id: "context-1", updatedAt: "2026-09-08T00:00:00Z" }],
    ["getSession", "/sessions/session-1", "session-1", session],
    ["getDebug", "/sessions/session-1/debug", "session-1", debug],
  ] as const)("%s uses GET and projects only supported response fields", async (method, path, id, data) => {
    const { client, fetchImpl } = setup({ ...data, signingKey: secret, metadata: { secret } });
    const result = await client[method](id);
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.browserbase.com/v1${path}`, expect.objectContaining({ method: "GET" }));
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("signingKey");
    expect(result).not.toHaveProperty("metadata");
    if (method === "getDebug") expect(result.pages[0]).toEqual({ id: "page-1", debuggerUrl: debug.pages[0].debuggerUrl, debuggerFullscreenUrl: debug.pages[0].debuggerFullscreenUrl });
    else expect(result).toEqual(data);
  });
  it("releases via POST, not DELETE", async () => {
    const { client, fetchImpl } = setup({ id: "session-1", status: "COMPLETED" });
    expect(await client.releaseSession("session-1")).toEqual({ id: "session-1", status: "COMPLETED" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.browserbase.com/v1/sessions/session-1", expect.objectContaining({ method: "POST", body: JSON.stringify({ status: "REQUEST_RELEASE" }) }));
  });
  it("deletes contexts with an empty 204 response", async () => {
    const { client, fetchImpl } = setup(null, 204);
    expect(await client.deleteContext("context-1")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.browserbase.com/v1/contexts/context-1", expect.objectContaining({ method: "DELETE" }));
  });
  it.each([undefined, "", ".", "..", "a/b", "a?key=secret", "%2f", "a\\b", "a\n", 123])("rejects unsafe input IDs %s without a request", async (id) => {
    const { client, fetchImpl } = setup();
    for (const method of ["getContext", "getSession", "getDebug", "releaseSession", "deleteContext"]) await sanitized(client[method](id));
    if (id !== undefined) await sanitized(client.createSession({ contextId: id }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ timeout: 59 }, { timeout: 21601 }, { timeout: 60.5 }, { persist: "true" }, { timeout: NaN }])("rejects malformed session options %j", async (options) => {
    const { client, fetchImpl } = setup();
    await sanitized(client.createSession(options));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([301, 401, 403, 404, 429, 500])("sanitizes HTTP %s without reading server body", async (status) => {
    const json = vi.fn(() => { throw new Error(secret); });
    const client = createBrowserbaseClient({ apiKey: secret, projectId: "project-1", fetchImpl: async () => ({ ok: false, status, statusText: secret, json }) });
    await sanitized(client.createContext());
    expect(json).not.toHaveBeenCalled();
  });
  it("sanitizes raw network errors including EnvironmentError causes", async () => {
    const client = createBrowserbaseClient({ apiKey: secret, projectId: "project-1", fetchImpl: async () => { throw new EnvironmentError(`URL https://example.com?key=${secret}`, { cause: secret }); } });
    await sanitized(client.createContext());
  });
  it("sanitizes malformed JSON", async () => {
    const client = createBrowserbaseClient({ apiKey: secret, projectId: "project-1", fetchImpl: async () => new Response(secret) });
    await sanitized(client.createContext());
  });
  it.each([
    ["createContext", null], ["createContext", []], ["createContext", {}], ["createContext", { id: "../bad" }],
    ["getContext", { id: "other-id" }], ["getContext", { id: "session-1", updatedAt: secret }],
    ["createSession", { id: "session-1", status: "RUNNING" }],
    ["createSession", { ...session, connectUrl: `https://example.com?key=${secret}` }],
    ["createSession", { ...session, connectUrl: "wss://user:pass@example.com" }],
    ["getSession", { id: "session-1" }], ["getSession", { id: "session-1", status: secret }],
    ["getSession", { ...session, contextId: "a/b" }], ["releaseSession", {}],
    ["getDebug", {}], ["getDebug", { ...debug, debuggerUrl: `javascript:${secret}` }],
    ["getDebug", { ...debug, wsUrl: "ws://example.com" }], ["getDebug", { ...debug, pages: [null] }],
  ])("sanitizes malformed %s output %#", async (method, data) => {
    const { client } = setup(data);
    await sanitized(method.startsWith("create") ? client[method]() : client[method]("session-1"));
  });
  it.each(["fetch", "body"])("aborts and bounds a stalled %s", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const client = createBrowserbaseClient({ apiKey: secret, projectId: "project-1", timeoutMs: 20, fetchImpl: async (_url, init) => {
      signal = init.signal;
      if (phase === "fetch") return new Promise(() => {});
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    } });
    const result = sanitized(client.createContext());
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).message).toMatch(/timed out/i);
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears timeout after success", async () => {
    vi.useFakeTimers();
    await setup({ id: "context-1" }).client.createContext();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, NaN, Infinity, 2 ** 31])("rejects invalid request timeout %s", (timeoutMs) => {
    expect(() => createBrowserbaseClient({ apiKey: secret, projectId: "project-1", timeoutMs })).toThrow(EnvironmentError);
  });
});
