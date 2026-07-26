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
  resolveStagingQaConfig,
  shouldPromptInteractively,
} from "../staging-qa-prompt.mjs";

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
        baseUrl: "https://staging.example.com",
        loginPath: "/login",
        expectedSubscriptionStatus: "INACTIVE",
      },
      pages: {
        dashboard: {
          pageUrl: "https://staging.example.com/dashboard",
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
        pageUrl: "https://staging.example.com/dashboard",
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
      expect(buildJudgeTargetUrl(target, "https://staging.example.com")).toBe(
        "https://staging.example.com/pricing",
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
      expect(config.baseUrl).toBe("https://staging.example.com");
      expect(config.loginPath).toBe("/login");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("does not override STAGING_QA_BASE_URL from env", async () => {
    const { previousCwd } = await loadFixtureConfig();
    process.env.STAGING_QA_BASE_URL = "https://env.example.com";
    try {
      const config = parseStagingQaArgs([]);
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe("https://env.example.com");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("does not override --base-url= from CLI", async () => {
    const { previousCwd } = await loadFixtureConfig();
    try {
      const config = parseStagingQaArgs(["--base-url=https://cli.example.com"]);
      applyStagingUrlDefaults(config, ["--base-url=https://cli.example.com"]);
      expect(config.baseUrl).toBe("https://cli.example.com");
    } finally {
      await restoreCwd(previousCwd);
    }
  });

  it("keeps placeholder baseUrl when config and env are absent", async () => {
    resetProjectConfigForTests();
    const config = parseStagingQaArgs([]);
    applyStagingUrlDefaults(config, []);
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });
});

describe("resolveFinalJudgeTarget (interactive n flow)", () => {
  it("keeps config pageUrl when user confirms", () => {
    const initial = {
      pageUrl: "https://staging.example.com/dashboard",
      targetPath: null,
    };
    expect(
      resolveFinalJudgeTarget(initial, "https://staging.example.com", {
        confirmed: true,
      }),
    ).toEqual(initial);
  });

  it("replaces config target when user declines and enters a full URL", () => {
    expect(
      resolveFinalJudgeTarget(
        {
          pageUrl: "https://staging.example.com/dashboard",
          targetPath: null,
        },
        "https://staging.example.com",
        { confirmed: false, customInput: "https://staging.example.com/ko" },
      ),
    ).toEqual({
      pageUrl: "https://staging.example.com/ko",
      targetPath: "/ko",
    });
  });

  it("replaces config target when user declines and enters a path", () => {
    expect(
      resolveFinalJudgeTarget(
        { targetPath: "/pricing", pageUrl: null },
        "https://staging.example.com",
        { confirmed: false, customInput: "/billing" },
      ),
    ).toEqual({
      pageUrl: "https://staging.example.com/billing",
      targetPath: "/billing",
    });
  });

  it("returns null when user declines with empty input", () => {
    expect(
      resolveFinalJudgeTarget(
        { pageUrl: "https://staging.example.com/dashboard", targetPath: null },
        "https://staging.example.com",
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

      expect(result.config.baseUrl).toBe("https://staging.example.com");
      expect(result.config.loginPath).toBe("/login");
      expect(result.config.expectedSubscriptionStatus).toBe("ACTIVE");
      expect(result.target).toEqual({
        targetPath: null,
        pageUrl: "https://staging.example.com/dashboard",
      });
      expect(buildJudgeTargetUrl(result.target, result.config.baseUrl)).toBe(
        "https://staging.example.com/dashboard",
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
        "https://staging.example.com/pricing",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
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
        loginUrl: "https://staging.example.com/login",
        email: "qa@example.com",
        password: "secret",
        targetUrl: "https://staging.example.com/dashboard",
      },
    });

    expect(query).toContain(
      "Target URL: https://staging.example.com/dashboard",
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
        customInput: "https://staging.example.com/ko/home",
      });

      expect(buildJudgeTargetUrl(afterDecline, config.baseUrl)).toBe(
        "https://staging.example.com/ko/home",
      );
    } finally {
      await restoreCwd(previousCwd);
    }
  });
});
