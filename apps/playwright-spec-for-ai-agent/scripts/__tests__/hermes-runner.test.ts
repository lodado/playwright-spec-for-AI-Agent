import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertHermesRunnerProtocol,
  buildHermesAgentArgs,
  buildHermesChildEnv,
  extractHermesFinalResponseText,
  extractJsonFromHermesOutput,
  prepareEphemeralHermesHome,
  prepareHermesJsonParseSurface,
  probeHermesRunnerProtocol,
  resolveTextOnlyDisabledToolsets,
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

  it("cannot remove mandatory text-only tool restrictions", () => {
    expect(
      resolveTextOnlyDisabledToolsets("browser,custom").split(","),
    ).toEqual(["*", "browser", "custom"]);
  });
});

describe("assertHermesRunnerProtocol", () => {
  it("accepts help text that documents --query and --max_turns", () => {
    expect(() =>
      assertHermesRunnerProtocol(
        "usage: hermes-agent --query=Q --max_turns=N --model=M",
      ),
    ).not.toThrow();
  });

  it("rejects help text without the legacy flags and names the fix", () => {
    expect(() =>
      assertHermesRunnerProtocol("usage: hermes run <task.json>"),
    ).toThrow(/hermes-agent CLI does not support --query\/--max_turns/);
  });
});

describe("probeHermesRunnerProtocol", () => {
  // The probe caches success in module state, so the failing case must run
  // before any test that verifies the CLI and sets that cache.
  it("surfaces the incompatible-CLI error from help output", () => {
    const spawn = vi.fn(() => ({
      stdout: "usage: hermes run <task.json>",
      stderr: "",
    }));
    expect(() => probeHermesRunnerProtocol({ spawn })).toThrow(
      /hermes-agent CLI does not support --query\/--max_turns/,
    );
  });

  it("passes when the CLI help advertises the required flags", () => {
    const spawn = vi.fn(() => ({
      stdout: "--query --max_turns --model",
      stderr: "",
    }));
    expect(() => probeHermesRunnerProtocol({ spawn })).not.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toContain("--help");
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

  it("does not seed generic env or persona files into text-only runs", () => {
    const { path, cleanup } = prepareEphemeralHermesHome({ mode: "text-only" });
    try {
      const entries = readdirSync(path);
      expect(entries).not.toContain(".env");
      expect(entries).not.toContain("SOUL.md");
    } finally {
      cleanup();
    }
  });

  it("removes partial credential homes when boot-file copying fails", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-home-failure-"));
    const sourceHome = join(root, "source");
    const destination = join(root, "destination");
    try {
      mkdirSync(sourceHome);
      mkdirSync(join(sourceHome, "auth.json"));
      expect(() =>
        prepareEphemeralHermesHome({
          mode: "text-only",
          sourceHome,
          makeTemporaryHome: () => {
            mkdirSync(destination);
            return destination;
          },
        }),
      ).toThrow();
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildHermesChildEnv", () => {
  it("isolates text-only Hermes from unrelated process credentials", () => {
    const source = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      STAGING_QA_PASSWORD: "staging-secret",
      SLACK_WEBHOOK_URL: "slack-secret",
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "provider-secret",
    };
    expect(buildHermesChildEnv("text-only", "/tmp/hermes", source)).toEqual({
      PATH: "/usr/bin",
      HTTPS_PROXY: "https://proxy.example",
      HOME: "/tmp/hermes",
      USERPROFILE: "/tmp/hermes",
      HERMES_HOME: "/tmp/hermes",
    });
    expect(buildHermesChildEnv("browse", "/tmp/hermes", source)).toMatchObject({
      STAGING_QA_PASSWORD: "staging-secret",
      HERMES_HOME: "/tmp/hermes",
    });
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
