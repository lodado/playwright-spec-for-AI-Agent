import { describe, expect, it } from "vitest";
import {
  configSchema,
  type DesignConvergenceConfigInput,
} from "../src/index.js";

function validConfig(
  overrides: Partial<DesignConvergenceConfigInput> = {},
): DesignConvergenceConfigInput {
  return {
    figma: { fileKey: "abc123" },
    execution: { allowProjectCode: false },
    cases: [
      {
        id: "pricing-desktop",
        route: "/pricing",
        viewport: { width: 1440, height: 900 },
        figmaRootNodeId: "1:2",
      },
    ],
    ...overrides,
  };
}

describe("configSchema safe defaults", () => {
  it("accepts a minimal valid config and applies documented defaults", () => {
    const r = configSchema.parse(validConfig());
    expect(r.project.rootDir).toBe(".");
    expect(r.instrumentation.attributeName).toBe("data-design-node");
    expect(r.instrumentation.envVar).toBe("DESIGN_CONVERGENCE");
    expect(r.comparison.severityWeights).toEqual({
      info: 0,
      low: 1,
      medium: 3,
      high: 8,
      critical: 20,
    });
    expect(r.comparison.ignoredProperties).toEqual(["cursor", "caret-color"]);
    expect(r.cases[0]!.viewport.deviceScaleFactor).toBe(1);
  });
});

describe("configSchema security-critical requirements (no defaults)", () => {
  it("requires execution.allowProjectCode", () => {
    const cfg = validConfig();
    delete (cfg as Partial<DesignConvergenceConfigInput>).execution;
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("configSchema case validation", () => {
  it("rejects duplicate case ids", () => {
    const cfg = validConfig({
      cases: [
        {
          id: "dup",
          route: "/a",
          viewport: { width: 1, height: 1 },
          figmaRootNodeId: "1:1",
        },
        {
          id: "dup",
          route: "/b",
          viewport: { width: 1, height: 1 },
          figmaRootNodeId: "1:2",
        },
      ],
    });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects an empty case list", () => {
    expect(configSchema.safeParse(validConfig({ cases: [] })).success).toBe(
      false,
    );
  });

  it("rejects a non-positive viewport dimension", () => {
    const cfg = validConfig({
      cases: [
        {
          id: "c",
          route: "/a",
          viewport: { width: 0, height: 900 },
          figmaRootNodeId: "1:1",
        },
      ],
    });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects a missing figma root node id", () => {
    const cfg = validConfig();
    delete (cfg.cases![0] as Record<string, unknown>).figmaRootNodeId;
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects an absolute-URL route", () => {
    const cfg = validConfig({
      cases: [
        {
          id: "c",
          route: "https://evil.com/x",
          viewport: { width: 1, height: 1 },
          figmaRootNodeId: "1:1",
        },
      ],
    });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects a protocol-relative route", () => {
    const cfg = validConfig({
      cases: [
        {
          id: "c",
          route: "//evil.com",
          viewport: { width: 1, height: 1 },
          figmaRootNodeId: "1:1",
        },
      ],
    });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("configSchema strictness", () => {
  it("rejects unknown top-level keys", () => {
    expect(configSchema.safeParse({ ...validConfig(), bogus: 1 }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys inside comparison", () => {
    const cfg = validConfig({ comparison: { typo: true } as never });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("configSchema command handling", () => {
  it("normalizes a safe command string to {executable, args}", () => {
    const r = configSchema.parse(validConfig({ app: { command: "pnpm dev" } }));
    expect(r.app?.command).toEqual({ executable: "pnpm", args: ["dev"] });
  });

  it("rejects a command string with shell metacharacters", () => {
    const cfg = validConfig({ app: { command: "pnpm dev && rm -rf /" } });
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });

  it("accepts an explicit {executable, args} command", () => {
    const r = configSchema.parse(
      validConfig({
        app: {
          command: { executable: "node", args: ["server.js", "--port=3000"] },
        },
      }),
    );
    expect(r.app?.command).toEqual({
      executable: "node",
      args: ["server.js", "--port=3000"],
    });
  });
});

describe("configSchema secrets and optional sections", () => {
  it("preserves a secret as a SecretRef, not a literal value", () => {
    const r = configSchema.parse(
      validConfig({
        figma: { fileKey: "k", accessToken: { env: "FIGMA_ACCESS_TOKEN" } },
      }),
    );
    expect(r.figma.accessToken).toEqual({ env: "FIGMA_ACCESS_TOKEN" });
  });

  it("validates the openai-compatible AI section", () => {
    const ok = configSchema.safeParse(
      validConfig({
        ai: {
          provider: "openai-compatible",
          baseURL: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: { env: "OPENAI_API_KEY" },
        },
      }),
    );
    expect(ok.success).toBe(true);

    const bad = configSchema.safeParse(
      validConfig({
        ai: {
          provider: "openai-compatible",
          baseURL: "not-a-url",
          model: "",
          apiKey: { env: "X" },
        },
      }),
    );
    expect(bad.success).toBe(false);
  });
});
