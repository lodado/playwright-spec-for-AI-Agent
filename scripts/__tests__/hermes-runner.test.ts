import { describe, expect, it } from "vitest";
import {
  buildHermesAgentArgs,
  extractHermesFinalResponseText,
  extractJsonFromHermesOutput,
  prepareHermesJsonParseSurface,
  unwrapHermesEnvelope,
} from "../hermes-runner.mjs";

describe("buildHermesAgentArgs", () => {
  it("passes disabled_toolsets as a separate argv (Fire comma-safe)", () => {
    const args = buildHermesAgentArgs("test query", 3, {
      disabledToolsets: "browser,web,terminal",
    });
    const idx = args.indexOf("--disabled_toolsets");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("browser,web,terminal");
    expect(args.some((a) => a.startsWith("--disabled_toolsets="))).toBe(false);
  });
});

describe("extractHermesFinalResponseText", () => {
  it("pulls JSON from FINAL RESPONSE block after banners", () => {
    const output = [
      "🤖 AI Agent with Tool Calling",
      "📝 User Query: test",
      "🎯 FINAL RESPONSE:",
      "------------------------------",
      '{"spec":{"ok":true},"livePlan":"**Given:**\\n- x"}',
      "==============================",
      "📋 CONVERSATION SUMMARY",
    ].join("\n");

    expect(extractHermesFinalResponseText(output)).toContain('"spec"');
  });
});

describe("extractJsonFromHermesOutput", () => {
  it("parses JSON from noisy stdout", () => {
    const noisy = `banner\n🎯 FINAL RESPONSE:\n---\n{"spec":{},"livePlan":"### 1. t\\n**Given:**\\n- a","changes":[]}`;
    const parsed = extractJsonFromHermesOutput(noisy, {
      requiredKeys: ["spec", "livePlan"],
    });
    expect(parsed.spec).toEqual({});
    expect(parsed.livePlan).toContain("Given");
  });

  it("unwraps envelope result string", () => {
    const inner = { status: "pass", checks: [] };
    const wrapped = JSON.stringify({
      type: "result",
      result: JSON.stringify(inner),
    });
    expect(
      extractJsonFromHermesOutput(wrapped, { requiredKeys: ["status"] }),
    ).toEqual(inner);
  });
});

describe("unwrapHermesEnvelope", () => {
  it("parses string result field", () => {
    expect(
      unwrapHermesEnvelope({
        result: '{"spec":{},"livePlan":"x","changes":[]}',
      }),
    ).toMatchObject({ spec: {}, livePlan: "x" });
  });
});

describe("prepareHermesJsonParseSurface", () => {
  it("merges stderr when stdout is banner-only", () => {
    const stdout = "🤖 AI Agent\n📝 User Query: hi";
    const stderr = '{"spec":{},"livePlan":"**Given:**\\n- a","changes":[]}';
    const surface = prepareHermesJsonParseSurface(stdout, stderr);
    expect(surface).toContain('"livePlan"');
  });
});
