import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPathTemplate,
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";

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
  it("preserves remediation patch policy from config", async () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-qa-remediation-"));
    const configPath = join(root, "playwright-spec-for-ai-agent.config.mjs");
    writeFileSync(
      configPath,
      `export default { remediation: { patch: { allowedPaths: ["src"], deniedPaths: ["src/secrets"], maxFiles: 2 } } };\n`,
    );
    const config = await loadProjectConfig([
      `--config=${configPath}`,
      `--root=${root}`,
    ]);
    expect(config.remediation).toEqual({
      patch: {
        allowedPaths: ["src"],
        deniedPaths: ["src/secrets"],
        maxFiles: 2,
      },
    });
  });
});
