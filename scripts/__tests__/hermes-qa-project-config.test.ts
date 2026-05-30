import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPathTemplate,
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";
import {
  parseTargetPathArg,
  resolveOutputDir,
  resolveSpecDir,
} from "../page-qa-paths.mjs";

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
            playwrightRun: true,
            outputDir: "custom-out/dashboard",
          },
        },
        targetPaths: { pricing: "/plans" },
        playwrightRunPages: [],
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
});
