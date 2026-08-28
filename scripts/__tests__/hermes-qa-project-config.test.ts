import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPathTemplate,
  applyStagingAccountDefaults,
  applyStagingUrlDefaults,
  defineConfig,
  getAllowedOrigins,
  getHooks,
  getLivePolicyOverrides,
  getProjectConfig,
  getStagingVersionUrl,
  isPlaceholderBaseUrl,
  listConfiguredPages,
  loadProjectConfig,
  mergeUploadFixtures,
  resetProjectConfigForTests,
  resolveDefaultUploadFixtures,
  resolveFixturePaths,
  resolveJudgeTarget,
} from "../hermes-qa-project-config.mjs";
import {
  parseTargetPathArg,
  resolveOutputDir,
  resolveSpecDir,
} from "../page-qa-paths.mjs";
import { DEFAULT_BASE_URL } from "../staging-qa-config.mjs";

afterEach(() => {
  resetProjectConfigForTests();
});

describe("applyPathTemplate", () => {
  it("replaces page and root placeholders", () => {
    expect(
      applyPathTemplate("e2e/{page}/tests", {
        page: "billing/settings",
        root: "/app",
      }),
    ).toBe("e2e/billing/settings/tests");
  });
});

describe("loadProjectConfig", () => {
  it("resolves pageUrl and staging baseUrl from config file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-qa-url-"));
    const configPath = join(root, "hermes-qa.config.mjs");
    writeFileSync(
      configPath,
      `export default {
        staging: {
          baseUrl: "https://staging.acmecorp.com",
          loginPath: "/sign-in",
        },
        pages: {
          home: {
            pageUrl: "https://staging.acmecorp.com/ko",
          },
          billing: {
            targetPath: "/settings/billing",
          },
        },
      };
`,
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([`--config=${configPath}`]);
      expect(resolveJudgeTarget([], "home")).toEqual({
        targetPath: null,
        pageUrl: "https://staging.acmecorp.com/ko",
      });
      expect(parseTargetPathArg([], "home")).toBe("/ko");
      expect(resolveJudgeTarget([], "billing")).toEqual({
        targetPath: "/settings/billing",
        pageUrl: null,
      });

      const config = { baseUrl: DEFAULT_BASE_URL, loginPath: "/login" };
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe("https://staging.acmecorp.com");
      expect(config.loginPath).toBe("/sign-in");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("applies page authRequired overrides from config file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-qa-auth-"));
    const configPath = join(root, "hermes-qa.config.mjs");
    writeFileSync(
      configPath,
      `export default {
        staging: {
          authRequired: true,
        },
        pages: {
          pricing: {
            authRequired: false,
          },
        },
      };
`,
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([`--config=${configPath}`]);
      const config = {};
      applyStagingAccountDefaults(config, "pricing");
      expect(config.authRequired).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("loads paths and per-page overrides from config file", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-qa-config-"));
    const configPath = join(root, "hermes-qa.config.mjs");
    writeFileSync(
      configPath,
      `export default {
        paths: {
          specDir: "tests/{page}",
          outputDir: "artifacts/{page}",
        },
          pages: {
          dashboard: {
            targetPath: "/app/home",
            outputDir: "custom-out/dashboard",
          },
        },
        targetPaths: { pricing: "/plans" },
      };
`,
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([`--config=${configPath}`]);
      expect(resolveSpecDir("dashboard")).toBe(join(root, "tests/dashboard"));
      expect(resolveOutputDir("dashboard")).toBe(
        join(root, "custom-out/dashboard"),
      );
      expect(resolveOutputDir("pricing")).toBe(join(root, "artifacts/pricing"));
      expect(parseTargetPathArg([], "dashboard")).toBe("/app/home");
      expect(parseTargetPathArg([], "pricing")).toBe("/plans");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("honors CLI --spec-dir and --output-dir overrides", async () => {
    resetProjectConfigForTests();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-qa-cli-")));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([
        "--spec-dir=playwright/{page}",
        "--output-dir=.qa/{page}",
      ]);
      expect(resolveSpecDir("settings")).toBe(
        join(root, "playwright/settings"),
      );
      expect(resolveOutputDir("settings")).toBe(join(root, ".qa/settings"));
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("loads upload fixtures with page overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-qa-fixtures-"));
    const configPath = join(root, "hermes-qa.config.mjs");
    writeFileSync(
      configPath,
      `export default {
        fixtures: { avatar: "tests/fixtures/global.png" },
        staging: {
          fixtures: { document: "tests/fixtures/doc.pdf" },
        },
        pages: {
          profile: {
            fixtures: { avatar: "tests/fixtures/profile.png" },
          },
        },
      };
`,
    );

    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig([`--config=${configPath}`]);
      expect(resolveDefaultUploadFixtures("profile")).toEqual({
        avatar: "tests/fixtures/profile.png",
        document: "tests/fixtures/doc.pdf",
      });
      expect(
        resolveFixturePaths({ avatar: "tests/fixtures/a.png" }, root),
      ).toEqual({
        avatar: join(root, "tests/fixtures/a.png"),
      });
      expect(
        mergeUploadFixtures(
          { avatar: "tests/fixtures/global.png" },
          { avatar: "tests/fixtures/test.png" },
        ),
      ).toEqual({ avatar: "tests/fixtures/test.png" });
    } finally {
      process.chdir(previousCwd);
    }
  });
});

/** Write `source` as a config file in a temp root, load it, and run `fn` there. */
async function withConfig(
  source: string,
  fn: (root: string) => void | Promise<void>,
  argv: string[] = [],
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-qa-cfg-")));
  const configPath = join(root, "hermes-qa.config.mjs");
  writeFileSync(configPath, source);
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    await loadProjectConfig([`--config=${configPath}`, ...argv]);
    await fn(root);
  } finally {
    process.chdir(previousCwd);
  }
}

describe("config key validation", () => {
  it("warns with a suggestion for a typo'd key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withConfig(
        `export default {
          paths: { specdir: "tests/{page}" },
          pages: { billing: { targetpath: "/billing" } },
        };
`,
        () => {},
      );
      const messages = warn.mock.calls.map(call => String(call[0]));
      expect(messages).toContain(
        '[qa-config] unknown config key "paths.specdir" — did you mean "specDir"?',
      );
      expect(messages).toContain(
        '[qa-config] unknown config key "pages.billing.targetpath" — did you mean "targetPath"?',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects wrongly typed values", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withConfig(
        `export default {
          staging: { authRequired: "yes" },
          pages: { home: { pageUrl: "not a url" } },
        };
`,
        () => {},
      );
      const messages = warn.mock.calls.map(call => String(call[0]));
      expect(messages).toContain(
        '[qa-config] "staging.authRequired" must be a boolean, got string',
      );
      expect(messages).toContain(
        '[qa-config] "pages.home.pageUrl" is not a valid URL: not a url',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("throws under --strict-config instead of warning", async () => {
    await expect(
      withConfig(
        `export default { paths: { specdir: "tests/{page}" } };
`,
        () => {},
        ["--strict-config"],
      ),
    ).rejects.toThrow(/unknown config key "paths\.specdir"/);
  });

  it("warns when the configured baseUrl is still a placeholder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withConfig(
        `export default { staging: { baseUrl: "https://your-staging-url.example.com" } };
`,
        () => {},
      );
      expect(warn.mock.calls.map(call => String(call[0]))).toContain(
        '[qa-config] "staging.baseUrl" is a placeholder (https://your-staging-url.example.com) — set a real staging origin before judging',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("isPlaceholderBaseUrl", () => {
  it("flags unset, unparseable, and example hosts", () => {
    expect(isPlaceholderBaseUrl("")).toBe(true);
    expect(isPlaceholderBaseUrl("nope")).toBe(true);
    expect(isPlaceholderBaseUrl("https://your-staging-url.example.com")).toBe(
      true,
    );
    expect(isPlaceholderBaseUrl("https://example.com")).toBe(true);
    expect(isPlaceholderBaseUrl("https://staging.acme.dev")).toBe(false);
  });
});

describe("per-page staging overrides", () => {
  it("prefers pages.{page} baseUrl and loginPath over the staging block", async () => {
    await withConfig(
      `export default {
        staging: { baseUrl: "https://app.acme.dev", loginPath: "/login" },
        pages: {
          billing: {
            baseUrl: "https://billing.acme.dev",
            loginPath: "/accounts/sign-in",
          },
          search: {},
        },
      };
`,
      () => {
        const billing: Record<string, string> = {};
        applyStagingUrlDefaults(billing, [], "billing");
        expect(billing.baseUrl).toBe("https://billing.acme.dev");
        expect(billing.loginPath).toBe("/accounts/sign-in");

        const search: Record<string, string> = {};
        applyStagingUrlDefaults(search, ["--page=search"]);
        expect(search.baseUrl).toBe("https://app.acme.dev");
        expect(search.loginPath).toBe("/login");
      },
    );
  });
});

describe("live policy overrides", () => {
  it("keeps valid verbs and drops invalid ones with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withConfig(
        `export default {
          livePolicies: {
            "billing/cancel": { liveRunPolicy: "blocked-subscription-mutation" },
            "billing/open": { liveRunPolicy: "executable-readonly", stagingMode: "read-only" },
            "billing/bogus": { liveRunPolicy: "yolo" },
          },
        };
`,
        () => {
          expect(getLivePolicyOverrides()).toEqual({
            "billing/cancel": {
              liveRunPolicy: "blocked-subscription-mutation",
            },
            "billing/open": {
              liveRunPolicy: "executable-readonly",
              stagingMode: "read-only",
            },
          });
        },
      );
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(
        /"livePolicies\.billing\/bogus\.liveRunPolicy" must be one of/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("returns an empty object when unset", async () => {
    await withConfig(`export default {};\n`, () => {
      expect(getLivePolicyOverrides()).toEqual({});
      expect(getHooks()).toEqual({});
      expect(getStagingVersionUrl("home")).toBeNull();
    });
  });
});

describe("getAllowedOrigins", () => {
  it("defaults to the resolved baseUrl origin, and honours false", async () => {
    await withConfig(
      `export default {
        staging: {
          baseUrl: "https://app.acme.dev",
          allowedOrigins: ["https://app.acme.dev"],
          versionUrl: "https://app.acme.dev/v.json",
        },
        pages: {
          billing: { baseUrl: "https://billing.acme.dev" },
          open: { allowedOrigins: false },
          extra: { allowedOrigins: ["https://cdn.acme.dev"] },
        },
      };
`,
      () => {
        expect(getAllowedOrigins("search")).toEqual(["https://app.acme.dev"]);
        expect(getAllowedOrigins("billing")).toEqual([
          "https://billing.acme.dev",
        ]);
        expect(getAllowedOrigins("open")).toEqual([]);
        expect(getAllowedOrigins("extra")).toEqual(["https://cdn.acme.dev"]);
        expect(getStagingVersionUrl("billing")).toBe(
          "https://app.acme.dev/v.json",
        );
      },
    );
  });
});

describe("listConfiguredPages", () => {
  it("unions pages and the legacy targetPaths block", async () => {
    await withConfig(
      `export default {
        pages: { search: { targetPath: "/search" } },
        targetPaths: { legacy: "/legacy" },
      };
`,
      () => {
        expect(listConfiguredPages()).toEqual(["legacy", "search"]);
      },
    );
  });

  it("no longer ships built-in dashboard/pricing target paths", async () => {
    await withConfig(`export default {};\n`, () => {
      expect(listConfiguredPages()).toEqual([]);
      expect(resolveJudgeTarget([], "dashboard")).toEqual({
        targetPath: null,
        pageUrl: null,
      });
    });
  });
});

describe("expectedAccountState", () => {
  it("reads the de-branded key and the legacy alias", async () => {
    await withConfig(
      `export default {
        staging: { expectedAccountState: "inactive" },
        pages: { billing: { expectedSubscriptionStatus: "active" } },
      };
`,
      () => {
        const billing: Record<string, unknown> = {};
        applyStagingAccountDefaults(billing, "billing");
        expect(billing.expectedSubscriptionStatus).toBe("ACTIVE");
        expect(billing.expectedAccountState).toBe("ACTIVE");

        const search: Record<string, unknown> = {};
        applyStagingAccountDefaults(search, "search");
        expect(search.expectedAccountState).toBe("INACTIVE");
      },
    );
  });
});

describe("getProjectConfig", () => {
  it("throws when loadProjectConfig was never awaited", () => {
    resetProjectConfigForTests();
    expect(() => getProjectConfig()).toThrow(
      /before loadProjectConfig\(\) was awaited/,
    );
  });

  it("warns and re-resolves when reloaded with different flags", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-qa-argv-")));
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await loadProjectConfig(["--spec-dir=a/{page}"]);
      expect(getProjectConfig().paths.specDir).toBe("a/{page}");
      await loadProjectConfig(["--spec-dir=b/{page}"]);
      expect(getProjectConfig().paths.specDir).toBe("b/{page}");
      expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toMatch(
        /re-resolving project config/,
      );
    } finally {
      process.chdir(previousCwd);
      warn.mockRestore();
    }
  });
});

describe("defineConfig", () => {
  it("round-trips its argument", () => {
    const config = { pages: { search: { targetPath: "/search" } } };
    expect(defineConfig(config)).toBe(config);
  });
});
