import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ fork: forkMock }));
import { resolveStagehandRequest, runStagehand } from "../stagehand-runner.mjs";
import { executeStagehandTask, resolveStagehandCdpUrl } from "../stagehand-process.mjs";

let dir: string;
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); forkMock.mockReset(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function env() {
  vi.stubEnv("QA_STAGEHAND_MODEL", "openai/gpt-4.1-mini");
  vi.stubEnv("BROWSER_CDP_URL", "http://127.0.0.1:9222");
  vi.stubEnv("QA_STAGEHAND_MAX_STEPS", "20");
  vi.stubEnv("QA_STAGEHAND_TIMEOUT_MS", "1000");
}

describe("Stagehand configuration", () => {
  it("requires an explicit model and a runner-owned session for browsing", () => {
    env(); vi.stubEnv("QA_STAGEHAND_MODEL", "");
    expect(() => resolveStagehandRequest("q", 10)).toThrow(/QA_STAGEHAND_MODEL/);
    vi.stubEnv("QA_STAGEHAND_MODEL", "openai/gpt-4.1-mini"); vi.stubEnv("BROWSER_CDP_URL", "");
    expect(() => resolveStagehandRequest("q", 10)).toThrow(/BROWSER_CDP_URL/);
    expect(resolveStagehandRequest("q", 10, { mode: "text-only" }).mode).toBe("text-only");
  });
  it("caps steps without expanding the harness budget", () => {
    env(); expect(resolveStagehandRequest("q", 5).maxSteps).toBe(5);
    expect(resolveStagehandRequest("q", 99).maxSteps).toBe(20);
    vi.stubEnv("QA_STAGEHAND_MAX_STEPS", "0");
    expect(() => resolveStagehandRequest("q", 5)).toThrow(/positive integer/);
  });
});

function sdk(result = { success: true, completed: true, output: { resultJson: '{"status":"fail"}' } }) {
  const execute = vi.fn().mockResolvedValue(result);
  const completion = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{"livePlan":[]}' } }] });
  const instance = { init: vi.fn(), close: vi.fn(), agent: vi.fn(() => ({ execute })), llmClient: { createChatCompletion: completion } };
  const Stagehand = vi.fn(function () { return instance; });
  const z = { string: () => ({ describe: () => ({}) }), object: (value: unknown) => value };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/test" }) });
  return { Stagehand, z, instance, execute, completion, fetch };
}

describe("Stagehand SDK task", () => {
  it("attaches locally, requests structured output and keeps QA fail distinct from execution success", async () => {
    env(); const fake = sdk();
    const response = await executeStagehandTask(resolveStagehandRequest("inspect", 3), fake);
    expect(JSON.parse(response.output).status).toBe("fail");
    expect(fake.Stagehand).toHaveBeenCalledWith(expect.objectContaining({ env: "LOCAL", disableAPI: true, experimental: true, localBrowserLaunchOptions: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test" } }));
    expect(fake.execute).toHaveBeenCalledWith(expect.objectContaining({ maxSteps: 3, instruction: expect.stringContaining("inspect") }));
    expect(fake.instance.init).toHaveBeenCalledTimes(1);
    expect(fake.instance.close).toHaveBeenCalledTimes(1);
  });
  it("never initializes a browser for text-only stages", async () => {
    env(); const fake = sdk();
    const response = await executeStagehandTask(resolveStagehandRequest("abstract", 1, { mode: "text-only" }), fake);
    expect(response.output).toBe('{"livePlan":[]}');
    expect(fake.instance.init).toHaveBeenCalledTimes(0);
    expect(fake.instance.agent).toHaveBeenCalledTimes(0);
    expect(fake.fetch).toHaveBeenCalledTimes(0);
    expect(fake.completion).toHaveBeenCalledTimes(1);
    expect(fake.instance.close).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete execution instead of trusting a proposed pass", async () => {
    env(); const fake = sdk({ success: true, completed: false, output: { resultJson: '{"status":"pass"}' } });
    await expect(executeStagehandTask(resolveStagehandRequest("q", 1), fake)).rejects.toThrow(/incomplete/);
    expect(fake.instance.close).toHaveBeenCalledTimes(1);
  });
  it("cleans up even after initialization fails", async () => {
    env(); const fake = sdk(); fake.instance.init.mockRejectedValue(new Error("CDP failed"));
    await expect(executeStagehandTask(resolveStagehandRequest("q", 1), fake)).rejects.toThrow("CDP failed");
    expect(fake.instance.close).toHaveBeenCalledTimes(1);
  });
  it("preserves the original error if cleanup also fails", async () => {
    env(); const fake = sdk();
    fake.instance.init.mockRejectedValue(new Error("original CDP failure"));
    fake.instance.close.mockRejectedValue(new Error("cleanup failure"));
    await expect(executeStagehandTask(resolveStagehandRequest("q", 1), fake)).rejects.toThrow("original CDP failure");
  });
  it("treats SDK-returned provider failures as environment failures", async () => {
    env(); const fake = sdk({ success: false, completed: false, output: { resultJson: "" }, message: "Failed to execute task: quota exceeded" } as any);
    await expect(executeStagehandTask(resolveStagehandRequest("q", 1), fake)).rejects.toMatchObject({ exitCode: 3 });
    expect(fake.instance.close).toHaveBeenCalledTimes(1);
  });
});

describe("Stagehand CDP URL compatibility", () => {
  it("discovers the WebSocket endpoint from an HTTP CDP address", async () => {
    const fetch = sdk().fetch;
    expect(await resolveStagehandCdpUrl("http://127.0.0.1:9222", 1000, fetch)).toBe("ws://127.0.0.1:9222/devtools/browser/test");
    expect(String(fetch.mock.calls[0][0])).toBe("http://127.0.0.1:9222/json/version");
  });
  it("passes WebSocket URLs through without HTTP requests", async () => {
    const fetch = vi.fn();
    expect(await resolveStagehandCdpUrl("ws://127.0.0.1:9222/devtools/browser/test", 1000, fetch)).toBe("ws://127.0.0.1:9222/devtools/browser/test");
    expect(fetch).toHaveBeenCalledTimes(0);
  });
  it("fails clearly on invalid discovery responses", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(resolveStagehandCdpUrl("http://127.0.0.1:9222", 1000, fetch)).rejects.toThrow(/no WebSocket endpoint/);
  });
});

function child() {
  const c = new EventEmitter() as any;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.connected = true;
  c.send = vi.fn(); c.kill = vi.fn(); c.disconnect = vi.fn(); c.unref = vi.fn();
  forkMock.mockReturnValue(c); return c;
}

describe("Stagehand process boundary", () => {
  it("transports prompts over IPC and redacts returned secrets", async () => {
    env(); const c = child(); dir = mkdtempSync(join(tmpdir(), "stagehand-test-"));
    const rawOutputPath = join(dir, "raw.txt");
    const pending = runStagehand("secret-value", 3, { secrets: ["secret-value"], paths: { hermesRawOutput: rawOutputPath } });
    expect(forkMock.mock.calls[0][1]).toEqual([]);
    expect(c.send.mock.calls[0][0].query).toBe("secret-value");
    c.emit("message", { type: "result", output: '{"status":"pass","summary":"secret-value"}' });
    c.emit("close", 0);
    const result = await pending;
    expect(result.summary).not.toContain("secret-value");
    expect(readFileSync(rawOutputPath, "utf8")).not.toContain("secret-value");
  });
  it("kills a stuck worker and persists partial redacted logs on timeout", async () => {
    env(); vi.useFakeTimers(); const c = child();
    dir = mkdtempSync(join(tmpdir(), "stagehand-timeout-"));
    const rawOutputPath = join(dir, "raw.txt");
    const pending = runStagehand("q", 1, { secrets: ["partial-secret"], paths: { hermesRawOutput: rawOutputPath } });
    c.stderr.emit("data", "working partial-secret");
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.kill).toHaveBeenCalledWith("SIGKILL");
    c.emit("close", null); await rejected;
    expect(readFileSync(rawOutputPath, "utf8")).toContain("working [redacted]");
  });
  it("rejects process exit without a result", async () => {
    env(); const c = child(); const pending = runStagehand("q", 1);
    c.emit("close", 0);
    await expect(pending).rejects.toThrow(/without a result/);
  });
  it("preserves invalid-output taxonomy and redacts SDK diagnostics", async () => {
    env(); const c = child(); const pending = runStagehand("q", 1, { secrets: ["private-key"] });
    c.emit("message", { type: "error", message: "incomplete private-key", exitCode: 4 });
    c.emit("close", 1);
    await expect(pending).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining("incomplete [redacted]") });
  });
});
