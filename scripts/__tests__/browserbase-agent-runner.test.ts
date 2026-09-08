import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAdapterCacheForTests } from "../ai-agent-adapter.mjs";
import { runBrowserbaseAgent } from "../browserbase-agent-runner.mjs";
import { AgentOutputError, EnvironmentError, UsageError, formatQaError } from "../errors.mjs";

const key = "WORKER_TEST_SECRET";
const cdpUrl = `wss://connect.example.test?apiKey=${key}&sessionId=private-session`;
const session = { cdpUrl, secrets: [key, cdpUrl] };
let root: string;
const errorsUrl = new URL("../errors.mjs", import.meta.url).href;

async function adapter(source: string) {
  const file = join(root, "adapter.mjs");
  writeFileSync(file, source);
  vi.stubEnv("QA_AI_ADAPTER", file);
  resetAdapterCacheForTests();
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR || tmpdir(), "bb-agent-worker-"));
  vi.stubEnv("BROWSERBASE_API_KEY", key);
  vi.stubEnv("BROWSER_CDP_URL", "parent-cdp");
  vi.stubEnv("PLAYWRIGHT_MCP_CDP_ENDPOINT", "parent-alias");
  vi.stubEnv("QA_AGENT_TIMEOUT_MS", "10000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAdapterCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("Browserbase isolated agent boundary", () => {
  it("keeps the parent responsive while a synchronous custom adapter runs with private CDP env", async () => {
    await adapter(`
      export const capabilities = { auth: 'cdp-attach' };
      export function run(query, maxTurns, options) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        return { status:'pass', isolated:process.pid !== ${process.pid}, query, maxTurns, mode:options.mode,
          keyMissing:process.env.BROWSERBASE_API_KEY === undefined,
          sameEndpoint:process.env.BROWSER_CDP_URL === process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT,
          endpoint:process.env.BROWSER_CDP_URL };
      }
    `);
    let heartbeat = false;
    const timer = setTimeout(() => { heartbeat = true; }, 10);
    try {
      const pending = runBrowserbaseAgent(session, "inspect", 7, { mode: "browse" });
      expect(process.env.BROWSER_CDP_URL).toBe("parent-cdp");
      const result = await pending;
      expect(heartbeat).toBe(true);
      expect(result).toMatchObject({ status: "pass", isolated: true, query: "inspect", maxTurns: 7,
        mode: "browse", keyMissing: true, sameEndpoint: true, endpoint: "[redacted]" });
      expect(result.agentMeta.adapter).toBe(join(root, "adapter.mjs"));
      expect(process.env.BROWSERBASE_API_KEY).toBe(key);
      expect(process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe("parent-alias");
    } finally { clearTimeout(timer); }
  });

  it.each([EnvironmentError, UsageError, AgentOutputError].map(Type => ({ name: Type.name, Type })))("preserves $name across IPC without secret-bearing fields", async ({ Type: ErrorType }) => {
    await adapter(`
      import { ${ErrorType.name} } from ${JSON.stringify(errorsUrl)};
      export function run() {
        const endpoint = process.env.BROWSER_CDP_URL;
        throw new ${ErrorType.name}('failed '+endpoint, { hint:'retry '+endpoint, cause:new Error(endpoint) });
      }
    `);
    const error = await runBrowserbaseAgent(session, "inspect", null).catch(error => error);
    expect(error).toBeInstanceOf(ErrorType);
    expect(error.exitCode).toBe(new ErrorType("test").exitCode);
    expect(error.hint).toBe("retry [redacted]");
    expect(error.cause).toBeUndefined();
    expect(`${formatQaError(error)} ${error.stack} ${JSON.stringify(error)}`).not.toContain(key);
    expect(`${formatQaError(error)} ${error.stack}`).not.toContain("private-session");
  });

  it("fails instead of waiting forever when the isolated process exits without an answer", async () => {
    // Do not prepare this module in the parent: process.exit belongs only in the child.
    const file = join(root, "exit.mjs");
    writeFileSync(file, "export function run() { process.exit(0); }");
    vi.stubEnv("QA_AI_ADAPTER", file);
    await expect(runBrowserbaseAgent(session, "inspect", null)).rejects.toThrow(/exit|answer|result/i);
  });

  it("bounds a stuck custom adapter and removes temporary signal listeners", async () => {
    await adapter("export function run() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); return {status:'pass'}; }");
    vi.stubEnv("QA_AGENT_TIMEOUT_MS", "30");
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await expect(runBrowserbaseAgent(session, "inspect", null)).rejects.toThrow(/timed out/i);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
  });

  it.each(["SIGINT", "SIGTERM"] as const)("rejects %s promptly so the caller can release its cloud session", async signal => {
    const ready = join(root, "ready");
    await adapter(`import { writeFileSync } from 'node:fs'; export function run() {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000); return {status:'pass'};
    }`);
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const pending = runBrowserbaseAgent(session, "inspect", null);
    await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
    process.emit(signal);
    const error = await pending.catch(error => error);
    expect(error).toBeInstanceOf(EnvironmentError);
    expect(error.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
  });

  it("suppresses even fragmented secret-bearing adapter console output", async () => {
    await adapter(`
      console.log('bootstrap '+process.env.BROWSER_CDP_URL);
      export function run() {
        const endpoint = process.env.BROWSER_CDP_URL;
        process.stdout.write(endpoint.slice(0, 12)); process.stdout.write(endpoint.slice(12));
        process.stderr.write(endpoint); return {status:'pass'};
      }
    `);
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    try {
      expect(await runBrowserbaseAgent(session, "inspect", null)).toMatchObject({ status: "pass" });
      expect(output.join("")).not.toMatch(/WORKER_TEST_SECRET|private-session|bootstrap/);
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });

  it("lets the public caller exit promptly while the adapter is blocked in native spawnSync", async () => {
    const ready = join(root, "native-ready");
    await adapter(`import {spawnSync} from 'node:child_process'; export function run() {
      spawnSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 1500);`)}],
        {stdio:'ignore', timeout:2000, killSignal:'SIGKILL'});
      return {status:'pass'};
    }`);
    const caller = spawn(process.execPath, ["--input-type=module", "-e", `
      import {runBrowserbaseAgent} from ${JSON.stringify(new URL("../browserbase-agent-runner.mjs", import.meta.url).href)};
      const pending = runBrowserbaseAgent(${JSON.stringify(session)}, 'inspect', null);
      await pending.catch(() => console.log('caller released'));
    `], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let releasedAt = 0, stderr = "";
    caller.stdout.on("data", () => { releasedAt = Date.now(); });
    caller.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => caller.kill("SIGKILL"), 6000);
    try {
      const closed = new Promise<number | null>(resolve => caller.once("close", resolve));
      await expect.poll(() => existsSync(ready), { timeout: 4000 }).toBe(true);
      caller.kill("SIGTERM");
      const code = await closed;
      expect(code, stderr).toBe(0);
      expect(releasedAt).toBeGreaterThan(0);
      expect(Date.now() - releasedAt).toBeLessThan(800);
    } finally { clearTimeout(timer); if (caller.exitCode === null) caller.kill("SIGKILL"); }
  }, 8000);
});
