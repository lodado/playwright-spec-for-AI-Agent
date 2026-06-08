import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPathTemplate,
  applyStagingUrlDefaults,
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
          baseUrl: "https://staging.example.com",
          loginPath: "/sign-in",
        },
        pages: {
          home: {
            pageUrl: "https://staging.example.com/ko",
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
        pageUrl: "https://staging.example.com/ko",
      });
      expect(parseTargetPathArg([], "home")).toBe("/ko");
      expect(resolveJudgeTarget([], "billing")).toEqual({
        targetPath: "/settings/billing",
        pageUrl: null,
      });

      const config = { baseUrl: DEFAULT_BASE_URL, loginPath: "/login" };
      applyStagingUrlDefaults(config, []);
      expect(config.baseUrl).toBe("https://staging.example.com");
      expect(config.loginPath).toBe("/sign-in");
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
