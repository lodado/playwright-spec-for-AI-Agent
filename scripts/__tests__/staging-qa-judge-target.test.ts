import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStagingUrlDefaults,
  loadProjectConfig,
  resetProjectConfigForTests,
  resolveJudgeTarget,
} from "../hermes-qa-project-config.mjs";
import { buildBrowseHermesQuery } from "../run-hermes-page-judge.mjs";
import {
  buildJudgeTargetUrl,
  DEFAULT_BASE_URL,
  parseStagingQaArgs,
  resolveFinalJudgeTarget,
} from "../staging-qa-config.mjs";
import {
  applyHiddenInputChunk,
  normalizeScenarioId,
  resolveStagingQaConfig,
  shouldPromptInteractively,
} from "../staging-qa-prompt.mjs";
import { resolveSpecForJudge } from "../resolve-spec-for-judge.mjs";
import { hashSpecDefinition } from "../spec-hash.mjs";
import { UsageError } from "../errors.mjs";

const ENV_KEYS = [
  "STAGING_QA_EMAIL",
  "STAGING_QA_PASSWORD",
  "STAGING_QA_BASE_URL",
  "STAGING_QA_LOGIN_PATH",
  "CI",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
  process.env.STAGING_QA_EMAIL = "qa@example.com";
  process.env.STAGING_QA_PASSWORD = "staging-secret";
  delete process.env.STAGING_QA_BASE_URL;
  delete process.env.STAGING_QA_LOGIN_PATH;
  delete process.env.CI;
});

afterEach(() => {
  resetProjectConfigForTests();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

async function loadFixtureConfig() {
  const root = mkdtempSync(join(tmpdir(), "judge-target-"));
  const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
  writeFileSync(
    configPath,
    `export default {
      staging: {
        baseUrl: "https://staging.acmecorp.com",
        loginPath: "/login",
        expectedSubscriptionStatus: "INACTIVE",
      },
      pages: {
        dashboard: {
          pageUrl: "https://staging.acmecorp.com/dashboard",
          expectedSubscriptionStatus: "ACTIVE",
        },
        pricing: {
          targetPath: "/pricing",
        },
        legacy: {},
      },
      targetPaths: {
        legacy: "/legacy-path",
      },
    };
`,
  );

  const previousCwd = process.cwd();
  process.chdir(root);
  await loadProjectConfig([`--config=${configPath}`]);
  return { root, previousCwd };
}

async function restoreCwd(previousCwd: string) {
  process.chdir(previousCwd);
}

describe("resolveJudgeTarget priority", () => {
  it("prefers CLI --target-path over config pageUrl", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      expect(
        resolveJudgeTarget(["--target-path=/override"], "dashboard"),
      ).toEqual({
        targetPath: "/override",
        pageUrl: null,
      });
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("uses pages.pageUrl when CLI is absent", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      expect(resolveJudgeTarget([], "dashboard")).toEqual({
        targetPath: null,
        pageUrl: "https://staging.acmecorp.com/dashboard",
      });
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("falls back to pages.targetPath joined with staging.baseUrl", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const target = resolveJudgeTarget([], "pricing");
      expect(target).toEqual({
        targetPath: "/pricing",
        pageUrl: null,
      });
      expect(buildJudgeTargetUrl(target, "https://staging.acmecorp.com")).toBe(
        "https://staging.acmecorp.com/pricing",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("falls back to legacy targetPaths when page has no url/path", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      expect(resolveJudgeTarget([], "legacy")).toEqual({
        targetPath: "/legacy-path",
        pageUrl: null,
      });
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});

describe("applyStagingUrlDefaults", () => {
  it("fills baseUrl and loginPath from project config", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const config = parseStagingQaArgs([]);
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe("https://staging.acmecorp.com");
      expect(config.loginPath).toBe("/login");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("does not override STAGING_QA_BASE_URL from env", async () => {
    const { previousCwd } = await loadFixtureConfig();
    process.env.STAGING_QA_BASE_URL = "https://env.acmecorp.com";
    try {
      const config = parseStagingQaArgs([]);
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe("https://env.acmecorp.com");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("does not override --base-url= from CLI", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const config = parseStagingQaArgs(["--base-url=https://cli.acmecorp.com"]);
      applyStagingUrlDefaults(config, ["--base-url=https://cli.acmecorp.com"]);
      expect(config.baseUrl).toBe("https://cli.acmecorp.com");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("keeps placeholder baseUrl when config and env are absent", async () => {
    // Config still has to be loaded — reading it unloaded is now an error —
    // but an empty project has no staging block to override the placeholder.
    const root = mkdtempSync(join(tmpdir(), "judge-target-empty-"));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([]);
      const config = parseStagingQaArgs([]);
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});

describe("resolveFinalJudgeTarget (interactive n flow)", () => {
  it("keeps config pageUrl when user confirms", () => {
    const initial = {
      pageUrl: "https://staging.acmecorp.com/dashboard",
      targetPath: null,
    };
    expect(
      resolveFinalJudgeTarget(initial, "https://staging.acmecorp.com", {
        confirmed: true,
      }),
    ).toEqual(initial);
  });

  it("replaces config target when user declines and enters a full URL", () => {
    expect(
      resolveFinalJudgeTarget(
        {
          pageUrl: "https://staging.acmecorp.com/dashboard",
          targetPath: null,
        },
        "https://staging.acmecorp.com",
        { confirmed: false, customInput: "https://staging.acmecorp.com/ko" },
      ),
    ).toEqual({
      pageUrl: "https://staging.acmecorp.com/ko",
      targetPath: "/ko",
    });
  });

  it("replaces config target when user declines and enters a path", () => {
    expect(
      resolveFinalJudgeTarget(
        { targetPath: "/pricing", pageUrl: null },
        "https://staging.acmecorp.com",
        { confirmed: false, customInput: "/billing" },
      ),
    ).toEqual({
      pageUrl: "https://staging.acmecorp.com/billing",
      targetPath: "/billing",
    });
  });

  it("returns null when user declines with empty input", () => {
    expect(
      resolveFinalJudgeTarget(
        { pageUrl: "https://staging.acmecorp.com/dashboard", targetPath: null },
        "https://staging.acmecorp.com",
        { confirmed: false, customInput: "   " },
      ),
    ).toBeNull();
  });
});

describe("resolveStagingQaConfig (non-interactive judge setup)", () => {
  it("merges staging defaults and preserves config pageUrl target", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const judgeTarget = resolveJudgeTarget([], "dashboard");
      const result = await resolveStagingQaConfig(["--non-interactive"], {
        page: "dashboard",
        target: judgeTarget,
        stepLabel: "dashboard Hermes judge",
      });

      expect(result.config.baseUrl).toBe("https://staging.acmecorp.com");
      expect(result.config.loginPath).toBe("/login");
      expect(result.config.expectedSubscriptionStatus).toBe("ACTIVE");
      expect(result.target).toEqual({
        targetPath: null,
        pageUrl: "https://staging.acmecorp.com/dashboard",
      });
      expect(buildJudgeTargetUrl(result.target, result.config.baseUrl)).toBe(
        "https://staging.acmecorp.com/dashboard",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("uses targetPath from config when pageUrl is not set", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const judgeTarget = resolveJudgeTarget([], "pricing");
      const result = await resolveStagingQaConfig(["-y"], {
        page: "pricing",
        target: judgeTarget,
      });

      expect(result.target).toEqual({
        targetPath: "/pricing",
        pageUrl: null,
      });
      expect(buildJudgeTargetUrl(result.target, result.config.baseUrl)).toBe(
        "https://staging.acmecorp.com/pricing",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});

describe("placeholder base URL guard", () => {
  it("refuses to resolve a judge run against the packaged placeholder", async () => {
    const root = mkdtempSync(join(tmpdir(), "judge-target-placeholder-"));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([]);
      await expect(
        resolveStagingQaConfig(["--non-interactive"], { page: "dashboard" }),
      ).rejects.toThrow(UsageError);
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});

describe("normalizeScenarioId", () => {
  it("keeps any non-empty @qa-scenario id, not just the suggested three", () => {
    expect(normalizeScenarioId(" trial_expired ")).toBe("TRIAL_EXPIRED");
    expect(normalizeScenarioId("ACTIVE")).toBe("ACTIVE");
    expect(normalizeScenarioId("")).toBe("");
    expect(normalizeScenarioId(null)).toBe("");
  });
});

describe("applyHiddenInputChunk", () => {
  it("accepts a pasted multi-character chunk with a trailing newline", () => {
    const result = applyHiddenInputChunk("", "pa$$word-123\n");
    expect(result).toEqual({
      value: "pa$$word-123",
      done: true,
      cancelled: false,
    });
  });

  it("accumulates across chunks and applies backspace inside a chunk", () => {
    const first = applyHiddenInputChunk("", "abc");
    expect(first).toMatchObject({ value: "abc", done: false });
    expect(applyHiddenInputChunk(first.value, "d\u007fe").value).toBe("abce");
  });

  it("reports ctrl-c inside a chunk as cancelled", () => {
    expect(applyHiddenInputChunk("", "ab\u0003cd")).toEqual({
      value: "ab",
      done: true,
      cancelled: true,
    });
  });
});

describe("resolveSpecForJudge staleness", () => {
  function writeSpecs(files: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "judge-spec-"));
    const paths: Record<string, string> = {
      specJson: join(root, "spec.json"),
      specLiveJson: join(root, "spec-live.json"),
    };
    for (const [key, value] of Object.entries(files)) {
      writeFileSync(paths[key], JSON.stringify(value));
    }
    return paths;
  }

  const raw = { scenarios: [{ scenarioId: "ACTIVE", tests: [] }] };

  it("reports ok when the live artifact was stamped from the raw spec", () => {
    const paths = writeSpecs({
      specJson: raw,
      specLiveJson: { ...raw, sourceHash: hashSpecDefinition(raw) },
    });

    const resolved = resolveSpecForJudge(paths)!;
    expect(resolved.planSource).toBe("spec-live.json");
    expect(resolved.staleness.ok).toBe(true);
  });

  it("detects a live artifact generated from a different raw spec", () => {
    const paths = writeSpecs({
      specJson: raw,
      specLiveJson: { ...raw, sourceHash: hashSpecDefinition({ scenarios: [] }) },
    });

    const resolved = resolveSpecForJudge(paths)!;
    expect(resolved.staleness.ok).toBe(false);
    expect(resolved.staleness.expected).toBe(hashSpecDefinition({ scenarios: [] }));
    expect(resolved.staleness.actual).toBe(hashSpecDefinition(raw));
  });

  it("treats an unstamped artifact as unverifiable, not stale", () => {
    const paths = writeSpecs({ specJson: raw, specLiveJson: raw });

    const resolved = resolveSpecForJudge(paths)!;
    expect(resolved.planSource).toBe("spec-live.json");
    expect(resolved.staleness).toEqual({
      ok: true,
      expected: null,
      actual: hashSpecDefinition(raw),
    });
  });

  it("is always ok for the raw spec itself and null when nothing exists", () => {
    const paths = writeSpecs({ specJson: raw });
    expect(resolveSpecForJudge(paths)).toMatchObject({
      planSource: "spec.json",
      staleness: { ok: true },
    });
    expect(resolveSpecForJudge(writeSpecs({}))).toBeNull();
  });
});

describe("shouldPromptInteractively", () => {
  it("is disabled with --non-interactive", () => {
    expect(shouldPromptInteractively(["--non-interactive"])).toBe(false);
  });

  it("is disabled when CI is set", () => {
    process.env.CI = "true";
    expect(shouldPromptInteractively([])).toBe(false);
  });
});

describe("buildBrowseHermesQuery target URL in prompt", () => {
  it("embeds config pageUrl as Target URL for Hermes", () => {
    const query = buildBrowseHermesQuery({
      judgeDocument: "## Plan",
      stagingLogin: {
        loginUrl: "https://staging.acmecorp.com/login",
        email: "qa@example.com",
        password: "secret",
        targetUrl: "https://staging.acmecorp.com/dashboard",
      },
    });

    expect(query).toContain(
      "Target URL: https://staging.acmecorp.com/dashboard",
    );
  });
});

describe("judge target end-to-end resolution", () => {
  it("resolves custom URL after interactive override into Hermes target", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const config = parseStagingQaArgs([]);
      applyStagingUrlDefaults(config, []);

      const fromConfig = resolveJudgeTarget([], "dashboard");
      const afterDecline = resolveFinalJudgeTarget(fromConfig, config.baseUrl, {
        confirmed: false,
        customInput: "https://staging.acmecorp.com/ko/home",
      });

      expect(buildJudgeTargetUrl(afterDecline, config.baseUrl)).toBe(
        "https://staging.acmecorp.com/ko/home",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});
