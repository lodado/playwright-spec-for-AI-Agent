import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAgentJson } from "../agent-output.mjs";
import { AgentOutputError } from "../errors.mjs";
import {
  buildHermesAgentArgs,
  extractHermesFinalResponseText,
  extractJsonFromHermesOutput,
  prepareEphemeralHermesHome,
  prepareHermesJsonParseSurface,
  unwrapHermesEnvelope,
} from "../hermes-runner.mjs";

describe("buildHermesAgentArgs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("quotes disabled_toolsets so Fire keeps a comma-separated string", () => {
    vi.stubEnv("HERMES_INFERENCE_MODEL", "test-model");

    const args = buildHermesAgentArgs("test query", 3, {
      disabledToolsets: "browser,web,terminal",
    });
    expect(args).toContain('--disabled_toolsets="browser,web,terminal"');
    expect(args).toContain("--model=test-model");
  });
});

describe("prepareEphemeralHermesHome", () => {
  it("boots stateless: fresh temp home with no memories/sessions carried over", () => {
    const { path, cleanup } = prepareEphemeralHermesHome();
    try {
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(basename(path)).toMatch(/^hermes-qa-home-/);

      // The whole point: no learned state seeded into the run.
      const entries = readdirSync(path);
      expect(entries).not.toContain("memories");
      expect(entries).not.toContain("sessions");
      expect(entries).not.toContain("state.db");
    } finally {
      cleanup();
    }
    expect(existsSync(path)).toBe(false);
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

  it("accepts requiredKeyGroups (testUpdates OR spec + livePlan)", () => {
    const patches = `{"testUpdates":[],"livePlan":"### 1. t\\n**Given:**\\n- a\\n**When:**\\n- b\\n**Then:**\\n- c"}`;
    expect(
      extractJsonFromHermesOutput(patches, {
        requiredKeyGroups: [
          ["livePlan", "testUpdates"],
          ["livePlan", "spec"],
        ],
      }),
    ).toMatchObject({
      testUpdates: [],
      livePlan: expect.stringContaining("Given"),
    });
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

  /**
   * `claude -p --output-format json` puts the model's answer in `result` as a
   * string, and the model routinely fences it. Without fence-aware unwrapping
   * the documented exec recipe reports "did not return valid JSON" for a run
   * that actually answered correctly.
   */
  it("unwraps an envelope result whose JSON is fenced", () => {
    const inner = { status: "pass", summary: "Example Domain" };
    const wrapped = JSON.stringify({
      type: "result",
      result: "```json\n" + JSON.stringify(inner) + "\n```",
    });
    expect(
      extractJsonFromHermesOutput(wrapped, { requiredKeys: ["status"] }),
    ).toEqual(inner);
  });

  it("prefers the final-response verdict over an HTTP status dumped on stderr", () => {
    const stdout = [
      "🎯 FINAL RESPONSE:",
      "------------------------------",
      '{"status":"fail","summary":"button missing","checks":[]}',
      "==============================",
    ].join("\n");
    const stderr =
      'RetryError: {"status":429,"error":{"message":"rate limited"}}';

    expect(
      extractAgentJson(stdout, { stderr, requiredKeys: ["status"] }),
    ).toMatchObject({ status: "fail" });
  });

  it("prefers the outermost object over a nested one at a later position", () => {
    const output =
      '{"status":"pass","checks":[],"raw":{"status":500,"body":"x"}}';
    expect(extractAgentJson(output, { requiredKeys: ["status"] })).toMatchObject(
      { status: "pass" },
    );
  });

  it("rejects a numeric status even when it is the only candidate", () => {
    expect(() =>
      extractAgentJson('{"status":429,"error":"rate limited"}', {
        requiredKeys: ["status"],
      }),
    ).toThrow(AgentOutputError);
  });

  it("honors a caller-supplied validate callback", () => {
    const output = '{"livePlan":"short"}\n{"livePlan":"### long enough plan"}';
    expect(
      extractAgentJson(output, {
        requiredKeys: ["livePlan"],
        validate: parsed => parsed.livePlan.startsWith("###"),
      }),
    ).toMatchObject({ livePlan: "### long enough plan" });
  });

  it("names the adapter and the raw artifact when nothing parses", () => {
    expect(() =>
      extractAgentJson("no json here", {
        adapterLabel: "aside",
        rawOutputPath: "/tmp/raw.txt",
      }),
    ).toThrow(/aside did not return valid JSON.*\/tmp\/raw\.txt/s);
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
