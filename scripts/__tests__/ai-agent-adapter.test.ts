import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdapterName, runAgent } from "../ai-agent-adapter.mjs";
import { buildAsideAgentArgs } from "../aside-runner.mjs";

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
