import { describe, expect, it } from "vitest";
import {
  parseSpecDirectory,
  parseSpecFile,
} from "../spec-annotation-reader.mjs";
import { hashFile, hashSpecDefinition, hashText } from "../spec-hash.mjs";
import {
  JUDGE_TURNS_MAX,
  JUDGE_TURNS_MIN,
  resolveJudgeTurnBudget,
} from "../judge-verdict.mjs";

const NON_EXISTENT_DIR = "/definitely/not/a/real/spec-dir";

function specSource(policy: string, title = "shows the list") {
  return [
    "// @qa-scenario: custom-policy",
    "// @qa-page: dashboard",
    `// @qa-live-policy: ${policy}`,
    `test("${title}", async ({ page }) => {});`,
    "",
  ].join("\n");
}

const CUSTOM = {
  "team-readonly": { liveRunPolicy: "executable-readonly" },
};

describe("parseSpecDirectory as a directory served by an in-memory io", () => {
  it("to be only the *.spec.ts entries the fake returns, read through the fake", () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      "b.spec.ts": specSource("readonly", "second"),
      "a.spec.ts": specSource("readonly", "first"),
      "notes.md": "ignored",
      "c.spec.tsx": specSource("readonly", "wrong extension"),
    };
    const io = {
      readdir: (dir: string) => {
        expect(dir).toBe(NON_EXISTENT_DIR);
        return Object.keys(files);
      },
      readFile: (path: string) => {
        reads.push(path);
        return files[path.slice(NON_EXISTENT_DIR.length + 1)];
      },
    };

    const result = parseSpecDirectory(NON_EXISTENT_DIR, { io });

    expect(result.sourceDirectory).toBe(NON_EXISTENT_DIR);
    expect(result.scenarios.map(s => s.sourceFile)).toEqual([
      "a.spec.ts",
      "b.spec.ts",
    ]);
    expect(reads).toEqual([
      `${NON_EXISTENT_DIR}/a.spec.ts`,
      `${NON_EXISTENT_DIR}/b.spec.ts`,
    ]);
  });

  it("to be a custom @qa-live-policy name resolved through livePolicyOverrides", () => {
    const io = {
      readdir: () => ["x.spec.ts"],
      readFile: () => specSource("team-readonly"),
    };

    const [scenario] = parseSpecDirectory(NON_EXISTENT_DIR, {
      io,
      livePolicyOverrides: CUSTOM,
    }).scenarios;

    expect(scenario.tests[0].liveRunPolicy).toBe("executable-readonly");
    expect(scenario.tests[0].stagingMode).toBe("read-only");
  });

  it("to be a TypeError when no io is supplied", () => {
    // @ts-expect-error io is required by contract
    expect(() => parseSpecDirectory(NON_EXISTENT_DIR, {})).toThrow(TypeError);
    // @ts-expect-error options object is required by contract
    expect(() => parseSpecDirectory(NON_EXISTENT_DIR)).toThrow(TypeError);
  });
});

describe("parseSpecFile as a spec with a configured custom live policy", () => {
  it("to be the configured name resolved onto its built-in verb", () => {
    const spec = parseSpecFile("x.spec.ts", specSource("team-readonly"), {
      livePolicyOverrides: CUSTOM,
    });

    expect(spec.tests[0]).toMatchObject({
      title: "shows the list",
      liveRunPolicy: "executable-readonly",
      stagingMode: "read-only",
    });
  });

  it("to be a UsageError that lists the configured names for an unknown name", () => {
    expect(() =>
      parseSpecFile("x.spec.ts", specSource("nope"), {
        livePolicyOverrides: CUSTOM,
      }),
    ).toThrow(
      "Unknown @qa-live-policy: nope. Use one of: readonly, safe-interaction, safe-interaction-no-confirm, mock-judgment, subscription-mutation, auth-mock, skip; or a configured custom policy: team-readonly",
    );
  });

  it("to be a UsageError without the custom suffix when none is configured", () => {
    expect(() => parseSpecFile("x.spec.ts", specSource("nope"))).toThrow(
      /^Unknown @qa-live-policy: nope\. Use one of: [^;]+$/,
    );
  });

  it("to be a UsageError when a configured name maps to an unknown liveRunPolicy", () => {
    expect(() =>
      parseSpecFile("x.spec.ts", specSource("bad"), {
        livePolicyOverrides: { bad: { liveRunPolicy: "executable-anything" } },
      }),
    ).toThrow(
      'Configured @qa-live-policy "bad" maps to unknown liveRunPolicy "executable-anything".',
    );
  });
});

describe("hashFile as a file read through an injected port", () => {
  it("to be hashText of exactly what the injected readFile returned", () => {
    const calls: string[] = [];
    const readFile = (path: string) => {
      calls.push(path);
      return "plan body\n";
    };

    expect(hashFile(NON_EXISTENT_DIR + "/plan.md", { readFile })).toBe(
      hashText("plan body\n"),
    );
    expect(calls).toEqual([NON_EXISTENT_DIR + "/plan.md"]);
  });
});

describe("hashSpecDefinition as a definition carrying stage stamps", () => {
  const content = { scenarios: [{ scenarioId: "s1" }], page: "dashboard" };

  it("to be unchanged by every stamp named in pipeline.md", () => {
    const stamped = {
      ...content,
      sourceHash: "sha256:a",
      generatedAt: "2026-01-01T00:00:00Z",
      schemaVersion: 3,
      agentMeta: { model: "m" },
      inputHash: "sha256:b",
    };

    expect(hashSpecDefinition(stamped)).toBe(hashSpecDefinition(content));
  });

  it("to be changed by a content field", () => {
    expect(hashSpecDefinition({ ...content, page: "other" })).not.toBe(
      hashSpecDefinition(content),
    );
  });
});

describe("resolveJudgeTurnBudget as a plan of executable tests", () => {
  it("to be the floored override when it is a positive number", () => {
    expect(resolveJudgeTurnBudget(3, 42.9)).toBe(42);
    expect(resolveJudgeTurnBudget(3, "7")).toBe(7);
    // an override is not clamped to the scaled min/max range
    expect(resolveJudgeTurnBudget(3, 1000)).toBe(1000);
  });

  it("to be the scaled budget when the override is zero, negative, NaN or absent", () => {
    for (const override of [0, -5, "abc", undefined, null]) {
      expect(resolveJudgeTurnBudget(3, override)).toBe(36);
    }
  });

  it("to be clamped at the minimum, scaled in the middle, and clamped at the maximum", () => {
    expect(JUDGE_TURNS_MIN).toBe(20);
    expect(JUDGE_TURNS_MAX).toBe(150);
    // 12 + 8n: n=0 -> 12 (below min), n=1 -> 20 (== min), n=2 -> 28
    expect(resolveJudgeTurnBudget(0, undefined)).toBe(JUDGE_TURNS_MIN);
    expect(resolveJudgeTurnBudget(1, undefined)).toBe(JUDGE_TURNS_MIN);
    expect(resolveJudgeTurnBudget(2, undefined)).toBe(28);
    // n=17 -> 148, n=18 -> 156 (above max)
    expect(resolveJudgeTurnBudget(17, undefined)).toBe(148);
    expect(resolveJudgeTurnBudget(18, undefined)).toBe(JUDGE_TURNS_MAX);
  });
});
