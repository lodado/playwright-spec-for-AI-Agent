import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAgentJson } from "../agent-output.mjs";
import { AgentOutputError } from "../errors.mjs";
import {
  buildHermesAgentArgs,
  extractHermesFinalResponseText,
  extractJsonFromHermesOutput,
  installEphemeralHermesBrowserTools,
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

describe("installEphemeralHermesBrowserTools", () => {
  it("creates an opt-in plugin without persisting the endpoint token", () => {
    const { path, cleanup } = prepareEphemeralHermesHome();
    try {
      installEphemeralHermesBrowserTools(path, {
        url: "http://127.0.0.1:4319/qa-tools",
        token: "test-secret-token",
      });

      const config = readFileSync(`${path}/config.yaml`, "utf8");
      const manifest = readFileSync(
        `${path}/plugins/qa_browser_tools/plugin.yaml`,
        "utf8",
      );
      const source = readFileSync(
        `${path}/plugins/qa_browser_tools/__init__.py`,
        "utf8",
      );
      expect(config).toContain("- qa-browser-tools");
      expect(config).toContain("disabled: []");
      expect(manifest).toContain("qa_checkpoint");
      expect(manifest).toContain("qa_upload_fixture");
      expect(source).toContain('name="qa_checkpoint"');
      expect(source).toContain('name="qa_upload_fixture"');
      expect(source).not.toContain("test-secret-token");
      expect(source).not.toContain("127.0.0.1:4319");
    } finally {
      cleanup();
    }
  });

  it("replaces quoted, inline, and duplicate plugin sections across comments", () => {
    const { path, cleanup } = prepareEphemeralHermesHome();
    try {
      writeFileSync(`${path}/config.yaml`, [
        "model:",
        "  default: preserved-model",
        "'plugins':",
        "  enabled: [unsafe-plugin]",
        "# a comment does not end this mapping",
        "  disabled: [qa-browser-tools]",
        '"plugins": {enabled: [another-plugin]}',
        "plugins:",
        "  enabled: [last-plugin]",
        "agent:",
        "  max_turns: 17",
        "",
      ].join("\n"));
      installEphemeralHermesBrowserTools(path, {
        url: "http://127.0.0.1:4319/",
        token: "test-token",
      });
      const config = readFileSync(`${path}/config.yaml`, "utf8");
      expect(config).toContain("model:\n  default: preserved-model");
      expect(config).toContain("agent:\n  max_turns: 17");
      expect(config.match(/^plugins:/gm)).toHaveLength(1);
      expect(config).toContain("enabled:\n    - qa-browser-tools");
      expect(config).toContain("disabled: []");
      expect(config).not.toMatch(/unsafe-plugin|another-plugin|last-plugin|disabled: \[qa-browser-tools\]/);
    } finally {
      cleanup();
    }
  });

  it("rejects incomplete browser tool credentials", () => {
    const { path, cleanup } = prepareEphemeralHermesHome();
    try {
      expect(() =>
        installEphemeralHermesBrowserTools(path, { url: "http://localhost" }),
      ).toThrow(/url and token/);
    } finally {
      cleanup();
    }
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
