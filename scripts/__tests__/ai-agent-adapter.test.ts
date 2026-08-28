import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeAdapter,
  prepareAdapter,
  resetAdapterCacheForTests,
  resolveAdapterName,
  runAgent,
} from "../ai-agent-adapter.mjs";
import { buildAsideAgentArgs } from "../aside-runner.mjs";
import { preloginAside } from "../aside-prelogin.mjs";
import { UsageError } from "../errors.mjs";

describe("resolveAdapterName", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to hermes", () => {
    vi.stubEnv("QA_AI_ADAPTER", "");
    expect(resolveAdapterName()).toBe("hermes");
  });

  it("selects aside via QA_AI_ADAPTER", () => {
    vi.stubEnv("QA_AI_ADAPTER", "aside");
    expect(resolveAdapterName()).toBe("aside");
  });

  it("rejects unknown adapters before spawning anything", () => {
    vi.stubEnv("QA_AI_ADAPTER", "gpt-cli");
    expect(() => runAgent("query", 1)).toThrow(/Unknown QA_AI_ADAPTER.*gpt-cli/);
  });

  it("lists every built-in and the module-specifier form when it rejects", () => {
    vi.stubEnv("QA_AI_ADAPTER", "gpt-cli");
    try {
      runAgent("query", 1);
      expect.unreachable();
    } catch (error) {
      const hint = (error as UsageError).hint;
      for (const name of ["hermes", "aside", "exec", "fixture"]) {
        expect(hint).toContain(name);
      }
      expect(hint).toContain("module specifier");
    }
  });
});

describe("describeAdapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports hermes as the CDP-attaching, turn-capped backend", () => {
    expect(describeAdapter("hermes")).toMatchObject({
      name: "hermes",
      prelogin: null,
      capabilities: {
        auth: "cdp-attach",
        supportsMaxTurns: true,
        supportsToolsetDisable: true,
        supportsVideo: true,
      },
    });
  });

  it("reports aside as self-prelogin and wires its prelogin function", () => {
    const described = describeAdapter("aside");
    expect(described.capabilities).toEqual({
      auth: "self-prelogin",
      supportsMaxTurns: false,
      supportsToolsetDisable: false,
      supportsVideo: false,
      blocksEventLoop: true,
    });
    expect(described.prelogin).toBe(preloginAside);
  });

  it("defaults exec to credentials-in-prompt, QA_AGENT_AUTH opts into CDP", () => {
    expect(describeAdapter("exec").capabilities.auth).toBe(
      "credentials-in-prompt"
    );
    vi.stubEnv("QA_AGENT_AUTH", "cdp-attach");
    expect(describeAdapter("exec").capabilities.auth).toBe("cdp-attach");
  });

  it("reports fixture as offline and model-free", () => {
    expect(describeAdapter("fixture").capabilities).toEqual({
      auth: "credentials-in-prompt",
      supportsMaxTurns: false,
      supportsToolsetDisable: false,
      supportsVideo: false,
      blocksEventLoop: true,
    });
  });

  it("describes the adapter named by QA_AI_ADAPTER by default", () => {
    vi.stubEnv("QA_AI_ADAPTER", "aside");
    expect(describeAdapter().name).toBe("aside");
  });
});

describe("module-specifier adapters", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    resetAdapterCacheForTests();
    vi.unstubAllEnvs();
  });

  function writeAdapterModule() {
    dir = mkdtempSync(join(tmpdir(), "qa-adapter-"));
    const modulePath = join(dir, "my-adapter.mjs");
    writeFileSync(
      modulePath,
      [
        "export const capabilities = { auth: 'cdp-attach', supportsVideo: true };",
        "export function resolveModel() { return 'third-party/model'; }",
        "export function run(query) { return { status: 'pass', summary: query }; }",
        "",
      ].join("\n")
    );
    return modulePath;
  }

  it("runs a third-party adapter after prepareAdapter resolves it", async () => {
    const modulePath = writeAdapterModule();
    vi.stubEnv("QA_AI_ADAPTER", modulePath);

    const described = await prepareAdapter();
    expect(described.capabilities).toMatchObject({
      auth: "cdp-attach",
      supportsVideo: true,
      supportsMaxTurns: false,
    });

    const result = runAgent("hello", 3, {});
    expect(result.status).toBe("pass");
    expect(result.source).toBe(modulePath);
    expect(result.agentMeta.model).toBe("third-party/model");
  });

  it("tells the operator to await prepareAdapter instead of failing obscurely", () => {
    const modulePath = writeAdapterModule();
    vi.stubEnv("QA_AI_ADAPTER", modulePath);
    expect(() => runAgent("hello", 3, {})).toThrow(/never loaded/);
    expect(() => describeAdapter()).toThrow(/prepareAdapter/);
  });

  it("rejects a module without a run export", async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-adapter-"));
    const modulePath = join(dir, "broken.mjs");
    writeFileSync(modulePath, "export const capabilities = {};\n");
    vi.stubEnv("QA_AI_ADAPTER", modulePath);
    await expect(prepareAdapter()).rejects.toThrow(/does not export a `run`/);
  });

  it("is a no-op for built-in adapters", async () => {
    vi.stubEnv("QA_AI_ADAPTER", "fixture");
    expect((await prepareAdapter()).name).toBe("fixture");
  });
});

describe("buildAsideAgentArgs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs exec with the query as the final positional arg", () => {
    vi.stubEnv("ASIDE_QA_MODEL", "");
    vi.stubEnv("ASIDE_QA_EFFORT", "");
    expect(buildAsideAgentArgs("check the page")).toEqual([
      "exec",
      "check the page",
    ]);
  });

  it("forwards ASIDE_QA_MODEL and ASIDE_QA_EFFORT as flags", () => {
    vi.stubEnv("ASIDE_QA_MODEL", "anthropic/claude-opus-4-6");
    vi.stubEnv("ASIDE_QA_EFFORT", "high");
    expect(buildAsideAgentArgs("q")).toEqual([
      "exec",
      "-m",
      "anthropic/claude-opus-4-6",
      "--effort",
      "high",
      "q",
    ]);
  });
});
