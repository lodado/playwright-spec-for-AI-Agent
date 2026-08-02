import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyPathTemplate,
  loadProjectConfig,
  resetProjectConfigForTests,
  resolveConfigBaseUrl,
  resolveJudgeTarget,
} from "../hermes-qa-project-config.mjs";

afterEach(resetProjectConfigForTests);

describe("project config", () => {
  it("loads the v3 page source and target settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "qa-native-config-"));
    const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
    writeFileSync(configPath, `export default {
      specDir: "specs/{page}",
      baseUrl: "https://default.test",
      pages: { settings: { baseUrl: "https://settings.test", targetPath: "/app/settings", scenario: "READY" } },
    };\n`);

    const config = await loadProjectConfig([`--config=${configPath}`, `--project-root=${root}`]);

    expect(config.specDir).toBe("specs/{page}");
    expect(config.pages.settings.scenario).toBe("READY");
    expect(resolveConfigBaseUrl("settings")).toBe("https://settings.test");
    expect(resolveJudgeTarget([], "settings")).toEqual({ targetPath: "/app/settings", pageUrl: null });
  });

  it("rejects removed v2 settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "qa-native-v2-config-"));
    const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
    writeFileSync(configPath, "export default { remediation: {} };\n");

    await expect(loadProjectConfig([`--config=${configPath}`])).rejects.toThrow(/unsupported v3 fields/);
  });

  it("expands page and root placeholders", () => {
    expect(applyPathTemplate("{root}/specs/{page}", { root: "/app", page: "billing/settings" })).toBe("/app/specs/billing/settings");
  });
});
